import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EMBEDDED_SITE_FILES} from '../scripts/build-embedded-desktop.mjs';
import {WEB_VERSION,WEB_RUNTIME_FILES,WEB_WINDOWS_FILES,webSourceFiles,prepareWebSources,buildWeb,parseWebBuildArgs} from '../scripts/build-web.mjs';

const privateMarker='DO_NOT_EXPORT_PRIVATE_FIXTURE';
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ludy-web-build-'))),source=path.join(root,'source'),out=path.join(root,'out');
  await fs.mkdir(source);t.after(()=>fs.rm(root,{recursive:true,force:true}));
  async function write(file,bytes){const name=path.join(source,file);await fs.mkdir(path.dirname(name),{recursive:true});await fs.writeFile(name,bytes);}
  for(const file of EMBEDDED_SITE_FILES)await write('site/'+file,file.endsWith('.js')?'export {};':'PUBLIC_FIXTURE');
  await write('site/index.html','<html><script src="config.js"></script><script src="desktop-auth.js"></script><script src="desktop-worker.js?v=1"></script><script src="app.js"></script></html>');
  await write('site/chauffeur.html','<html><script src="config.js"></script><script src="chauffeur.js"></script></html>');
  for(const file of WEB_RUNTIME_FILES)await write('web-runtime/'+file,'export {};');
  for(const file of WEB_WINDOWS_FILES)await write('web-runtime/windows/'+file,'# PUBLIC_WINDOWS_FIXTURE');
  await write('web-runtime/config.mjs',"import '../desktop/embedded-config.cjs';");
  await write('web-runtime/services.mjs',"import '../server/fleet.mjs'; import '../desktop-runtime/transport.mjs'; import('../server/uber-earnings.mjs');");
  await write('web-runtime/transport.mjs',"import '../desktop-runtime/admin-context.mjs';");
  await write('server/fleet.mjs',"import '../site/revenue-metrics.js';");
  await write('server/uber-earnings.mjs',"import '../uber-extension/earnings-reader.js';");
  await write('uber-extension/earnings-reader.js','export {};');
  await write('desktop/embedded-config.cjs','module.exports={};');
  await write('desktop-runtime/transport.mjs',"import './admin-context.mjs';");
  await write('desktop-runtime/admin-context.mjs','export {};');
  // Required by the existing candidate helper, intentionally not web reachable.
  await write('desktop-runtime/server.mjs',privateMarker);
  await write('desktop-runtime/services.mjs',privateMarker);
  await write('server/unreferenced.mjs',privateMarker);
  await write('server/.env',privateMarker);
  await write('site/config.js',privateMarker);
  await write('site/not-public.json',privateMarker);
  await write('.local/production/session.json',privateMarker);
  await write('production/private.sql',privateMarker);
  await write('node_modules/untrusted/index.js',privateMarker);
  await write('uber-extension/ludy-uber-chromium.zip',privateMarker);
  await write('uber-extension/reports-reader.js',privateMarker);
  await write('web-runtime/windows/operator-secrets.json',privateMarker);
  await write('desktop/package.json',JSON.stringify({version:'9.9.9',private:true}));
  await write('desktop/node_modules/electron/electron.exe',privateMarker);
  await write('package.json',JSON.stringify({name:'fixture-web',private:true,type:'module'}));
  await write('package-lock.json',JSON.stringify({name:'fixture-web',lockfileVersion:3,packages:{'':{name:'fixture-web'}}}));
  await write('vendor/xlsx-0.20.3.tgz','PUBLIC_VENDOR_FIXTURE');
  return {root,source,out,write};
}

test('the repository web graph includes its installer and pure earnings reader without a desktop or collector runtime',async()=>{
  const files=await webSourceFiles();
  for(const required of [...WEB_RUNTIME_FILES.map(file=>'web-runtime/'+file),...WEB_WINDOWS_FILES.map(file=>'web-runtime/windows/'+file),'server/fleet.mjs','server/uber-earnings.mjs','uber-extension/earnings-reader.js'])assert.ok(files.includes(required),required);
  assert.deepEqual(files.filter(file=>file.startsWith('desktop-runtime/')),['desktop-runtime/admin-context.mjs','desktop-runtime/transport.mjs']);
  assert.deepEqual(files.filter(file=>file.startsWith('desktop/')),['desktop/embedded-config.cjs']);
  assert.deepEqual(files.filter(file=>file.startsWith('uber-extension/')),['uber-extension/earnings-reader.js']);
  assert.ok(!files.some(file=>/(?:^|\/)(?:\.local|node_modules|production|electron)(?:\/|$)|(?:^|\/)config\.js$|\.(?:zip|env)$|(?:collector|browser)/i.test(file)));
});

test('web package includes only public site and reachable modules, excluding desktop auth and all local state',async t=>{
  const f=await fixture(t),prepared=await prepareWebSources(f.out,f.source),files=prepared.inventory.map(file=>file.path);
  assert.equal(prepared.version,'0.1.0');assert.equal(WEB_VERSION,'0.1.0');
  for(const required of [...WEB_RUNTIME_FILES.map(file=>'web-runtime/'+file),...WEB_WINDOWS_FILES.map(file=>'web-runtime/windows/'+file),'server/fleet.mjs','server/uber-earnings.mjs','uber-extension/earnings-reader.js','desktop/embedded-config.cjs','desktop-runtime/transport.mjs','desktop-runtime/admin-context.mjs','site/index.html','package-lock.json','vendor/xlsx-0.20.3.tgz'])assert.ok(files.includes(required),required);
  for(const forbidden of ['desktop-runtime/server.mjs','desktop-runtime/services.mjs','desktop/package.json','desktop/node_modules/electron/electron.exe','site/config.js','site/desktop-auth.js','site/desktop-worker.js','site/uber-extension.html','server/unreferenced.mjs','server/.env','site/not-public.json','uber-extension/ludy-uber-chromium.zip','uber-extension/reports-reader.js','production/private.sql','.local/production/session.json','node_modules/untrusted/index.js','web-runtime/windows/operator-secrets.json'])assert.ok(!files.includes(forbidden),forbidden);
  const html=await fs.readFile(path.join(f.out,'site/index.html'),'utf8');assert.doesNotMatch(html,/desktop-auth|desktop-worker/);assert.match(html,/src="config.js"/);assert.match(html,/src="app.js"/);
  for(const file of prepared.inventory){
    const bytes=await fs.readFile(path.join(f.out,file.path));assert.ok(!bytes.includes(privateMarker));
    assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(file.bytes,bytes.length);
  }
});

test('an import outside the web allowlist fails before creating a deployable bundle',async t=>{
  const f=await fixture(t);await f.write('web-runtime/services.mjs',"import '../.local/production/session.json';");
  await assert.rejects(prepareWebSources(f.out,f.source),/allowlist web/);
  await assert.rejects(fs.access(f.out),{code:'ENOENT'});
});

test('a referenced missing module and a public script that imports server code fail closed',async t=>{
  const f=await fixture(t);await f.write('web-runtime/services.mjs',"import '../server/missing.mjs';");
  await assert.rejects(webSourceFiles(f.source),/allowlist web/);
  await f.write('web-runtime/services.mjs','export {};');await f.write('site/app.js',"import '../server/fleet.mjs';");
  await assert.rejects(webSourceFiles(f.source),/Import serveur interdit/);
});

test('source symlinks and existing output directories are not followed or overwritten',async t=>{
  const f=await fixture(t);await fs.mkdir(f.out);await fs.writeFile(path.join(f.out,'keep.txt'),'KEEP');
  await assert.rejects(prepareWebSources(f.out,f.source),{code:'EEXIST'});assert.equal(await fs.readFile(path.join(f.out,'keep.txt'),'utf8'),'KEEP');
  await fs.rename(path.join(f.source,'site'),path.join(f.source,'original-site'));
  await fs.symlink(path.join(f.source,'original-site'),path.join(f.source,'site'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(webSourceFiles(f.source),/Source non régulière/);
});

test('build installs locked production dependencies in isolation and manifests the full portable bundle',async t=>{
  const f=await fixture(t),calls=[];
  const runCommand=async(command,args,options)=>{
    calls.push({command,args,options});
    if(calls.length===1){
      assert.deepEqual(args,['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--bin-links=false']);assert.equal(options.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD,'1');
      await fs.mkdir(path.join(options.cwd,'node_modules/example'),{recursive:true});await fs.writeFile(path.join(options.cwd,'node_modules/example/index.js'),'module.exports={};');
    }else{assert.equal(command,process.execPath);assert.deepEqual(args.slice(0,2),['--input-type=module','--eval']);assert.match(args[2],/web-runtime\/services\.mjs/);}
  };
  const result=await buildWeb({out:f.out,sourceRoot:f.source,runCommand});assert.equal(calls.length,2);
  assert.equal(result.version,'0.1.0');assert.equal(result.nodeIncluded,false);assert.equal(result.configurationEmbedded,false);assert.equal(result.productionAccess,false);
  const manifestBytes=await fs.readFile(path.join(f.out,'build-manifest.json')),manifest=JSON.parse(manifestBytes);
  assert.equal(result.manifestSha256,createHash('sha256').update(manifestBytes).digest('hex'));
  assert.equal(manifest.collector,false);assert.equal(manifest.configurationEmbedded,false);assert.equal(manifest.dependencies.length,1);
  assert.equal(manifest.dependencies[0].path,'example/index.js');assert.equal(manifest.entrypoint,'web-runtime/main.mjs');
  assert.deepEqual(JSON.parse(await fs.readFile(f.out+'.json','utf8')),result);
  await assert.rejects(buildWeb({out:f.out,sourceRoot:f.source,runCommand}),/existe déjà/);assert.equal(calls.length,2);
  assert.ok(!(await fs.readdir(f.root)).some(name=>name.startsWith('.web-build-')));
});

test('failed dependency install leaves no published bundle and never deletes an existing release',async t=>{
  const f=await fixture(t);
  await assert.rejects(buildWeb({out:f.out,sourceRoot:f.source,runCommand:async()=>{throw Error('synthetic install failure');}}),/synthetic install failure/);
  await assert.rejects(fs.access(f.out),{code:'ENOENT'});assert.ok(!(await fs.readdir(f.root)).some(name=>name.startsWith('.web-build-')));
});

test('web build options have an independent version and accept only explicit fresh output or checks',()=>{
  assert.ok(parseWebBuildArgs([]).out.endsWith(path.join('releases','web','Ludy-Web-0.1.0')));
  assert.equal(parseWebBuildArgs(['--check']).check,true);assert.equal(parseWebBuildArgs(['--out','./synthetic']).out,path.resolve('synthetic'));
  for(const args of [['--config','private.json'],['--out'],['--out','--check'],['--check','--check'],['--out','a','--out','b']])assert.throws(()=>parseWebBuildArgs(args));
});
