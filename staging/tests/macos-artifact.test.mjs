import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {parseMacArtifactArgs,assertNativeMacTarget,parseEmbeddedBuildOutput,inventoryMacApp,compareMacInventories,validateMacZipMembers,packageMacArtifact,buildMacArtifact} from '../scripts/build-macos-artifact.mjs';
const execute=promisify(execFile),mac={platform:'darwin',arch:'arm64',nodeVersion:'22.12.0'},ref='abcdefghijklmnopqrst';
const config={environment:'production',projectRef:ref,supabaseUrl:'https://'+ref+'.supabase.co',publishableKey:'sb_publishable_synthetic_public_key_1234567890'};
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ludy-mac-artifact-'))),app=path.join(root,'Ludy.app');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const relative of ['Contents/MacOS','Contents/Frameworks/Example.framework/Versions/A/Resources'])await fs.mkdir(path.join(app,relative),{recursive:true});
  await fs.writeFile(path.join(app,'Contents/MacOS/Ludy'),'synthetic executable',{mode:0o755});
  await fs.writeFile(path.join(app,'Contents/Frameworks/Example.framework/Versions/A/Example'),'synthetic framework',{mode:0o755});
  await fs.writeFile(path.join(app,'Contents/Frameworks/Example.framework/Versions/A/Resources/data.json'),'{}',{mode:0o644});
  await fs.symlink('A',path.join(app,'Contents/Frameworks/Example.framework/Versions/Current'));
  await fs.symlink('Versions/Current/Example',path.join(app,'Contents/Frameworks/Example.framework/Example'));
  const configPath=path.join(root,'public.json');await fs.writeFile(configPath,JSON.stringify(config));
  return{root,app,configPath,outputDir:path.join(root,'output')};
}
function portableCommands({afterExtraction,signature='adhoc',architecture='arm64'}={}){
  const calls=[];
  const command=async(name,args)=>{
    calls.push({name,args});
    if(name==='/usr/bin/codesign')return{stdout:'',stderr:args[0]==='--display'?'Signature='+signature+'\n':''};
    if(name==='/usr/bin/lipo')return{stdout:architecture+'\n',stderr:''};
    if(name==='/usr/bin/ditto'){
      if(args[0]==='-c')return execute('zip',['-q','-r','-y',args.at(-1),'Ludy.app'],{cwd:path.dirname(args.at(-2)),encoding:'utf8'});
      const output=await execute('unzip',['-q',args[2],'-d',args[3]],{encoding:'utf8'});await afterExtraction?.(path.join(args[3],'Ludy.app'));return output;
    }
    return execute(name,args,{encoding:'utf8'});
  };
  return{calls,command};
}
test('CLI requires one explicit native Mac target, public config and output directory',()=>{
  const good=['--config','public.json','--target','macos-arm64','--output-dir','out'];
  assert.equal(parseMacArtifactArgs(good).target,'macos-arm64');assert.equal(parseMacArtifactArgs([...good,'--check']).check,true);
  for(const args of [[],good.slice(0,-2),[...good,'--target','macos-x64'],['--config','--target','macos-arm64','--output-dir','out'],['--config','x','--target','windows-x64','--output-dir','out'],[...good,'--mac-local-test']])assert.throws(()=>parseMacArtifactArgs(args));
  assertNativeMacTarget('macos-arm64',mac);assertNativeMacTarget('macos-x64',{...mac,arch:'x64'});
  for(const host of [{...mac,platform:'linux'},{...mac,platform:'win32'},{...mac,arch:'x64'},{...mac,nodeVersion:'20.19.0'},{...mac,macVersion:'12.7.0'}])assert.throws(()=>assertNativeMacTarget('macos-arm64',host));
});
test('build output accepts packager progress before final JSON but never trailing or malformed data',()=>{
  const value={target:'macos-arm64',version:'0.2.0'};
  for(const prefix of ['', 'Packaging app for platform darwin arm64 using electron v45.2.1\n', '{progress only}\n'])assert.deepEqual(parseEmbeddedBuildOutput(prefix+JSON.stringify(value,null,2)+'\n'),value);
  for(const text of ['', 'Packaging failed', '{"target":', JSON.stringify(value)+'\nunexpected trailer'])assert.throws(()=>parseEmbeddedBuildOutput(text),/JSON/);
});
test('bundle inventory preserves executable modes and framework links and refuses escaping links',async t=>{
  const {app,root}=await fixture(t),inventory=await inventoryMacApp(app);
  assert.equal(inventory.find(x=>x.path==='Contents/MacOS/Ludy').mode,0o755);
  assert.equal(inventory.find(x=>x.path.endsWith('/Versions/Current')).target,'A');
  assert.doesNotThrow(()=>compareMacInventories(inventory,structuredClone(inventory)));
  const changed=structuredClone(inventory);changed.find(x=>x.path==='Contents/MacOS/Ludy').mode=0o644;assert.throws(()=>compareMacInventories(inventory,changed));
  await fs.writeFile(path.join(root,'outside'),'private');await fs.symlink('../../../outside',path.join(app,'Contents/Frameworks/outside'));
  await assert.rejects(inventoryMacApp(app),/extérieur/);
});
test('archive listing rejects traversal, duplicate entries and extraneous payloads',()=>{
  assert.equal(validateMacZipMembers('Ludy.app/\nLudy.app/Contents/\nLudy.app/Contents/MacOS/Ludy\n'),3);
  for(const listing of ['', '/Ludy.app/Contents/file','Ludy.app/../private','__MACOSX/Ludy.app','Ludy.app/a\nLudy.app/a','Ludy.app/a\\b','Ludy.app/./a'])assert.throws(()=>validateMacZipMembers(listing));
});
test('packaging verifies a real ZIP roundtrip with links and publishes complete truthful metadata',async t=>{
  const f=await fixture(t),{command,calls}=portableCommands();
  const result=await packageMacArtifact({appPath:f.app,outputDir:f.outputDir,target:'macos-arm64',version:'0.2.0',projectRef:ref},{command,currentHost:mac});
  const manifest=JSON.parse(await fs.readFile(path.join(f.outputDir,'manifest.json'),'utf8'));assert.deepEqual(manifest,result);
  assert.equal(result.signing,'adhoc');assert.equal(result.notarized,false);assert.equal(result.gatekeeperApproved,false);assert.equal(result.runtimeVerified,false);assert.equal(result.productionAccess,false);
  assert.equal(result.archiveVerified,true);assert.equal(result.permissionsVerified,true);assert.equal(result.symlinksVerified,true);
  assert.equal(result.sha256,createHash('sha256').update(await fs.readFile(result.file)).digest('hex'));
  assert.equal(await fs.readFile(result.sha256File,'utf8'),result.sha256+'  '+path.basename(result.file)+'\n');
  const bundle=JSON.parse(await fs.readFile(result.bundleManifestFile,'utf8'));assert.equal(bundle.format,'ludy-macos-app-bundle-v1');assert.deepEqual(bundle.entries,await inventoryMacApp(f.app));
  assert.equal(calls.filter(x=>x.name==='/usr/bin/codesign'&&x.args[0]==='--verify').length,2);
  assert.deepEqual(calls.find(x=>x.name==='/usr/bin/ditto').args.slice(0,4),['-c','-k','--keepParent','--norsrc']);
  const readme=await fs.readFile(result.readmeFile,'utf8');assert.match(readme,/xattr -cr ~\/Downloads\/Ludy\.app\nopen ~\/Downloads\/Ludy\.app/);assert.match(readme,/pas signée Developer ID/);assert.doesNotMatch(readme,/spctl|sudo|no-sandbox/);
});
test('lost permissions or altered payload after extraction prevents publication',async t=>{
  for(const kind of ['permissions','bytes'])await t.test(kind,async t=>{
    const f=await fixture(t),{command}=portableCommands({afterExtraction:async app=>{const file=path.join(app,'Contents/MacOS/Ludy');if(kind==='permissions')await fs.chmod(file,0o644);else await fs.writeFile(file,'altered');}});
    await assert.rejects(packageMacArtifact({appPath:f.app,outputDir:f.outputDir,target:'macos-arm64',version:'0.2.0',projectRef:ref},{command,currentHost:mac}),/conserve pas exactement/);
    await assert.rejects(fs.stat(f.outputDir),{code:'ENOENT'});
  });
});
test('wrong architecture or signing identity fails and existing output is never overwritten',async t=>{
  const f=await fixture(t),args={appPath:f.app,outputDir:f.outputDir,target:'macos-arm64',version:'0.2.0',projectRef:ref};
  for(const options of [{architecture:'x86_64'},{signature:'Developer ID'}])await assert.rejects(packageMacArtifact(args,{command:portableCommands(options).command,currentHost:mac}));
  await fs.mkdir(f.outputDir);await fs.writeFile(path.join(f.outputDir,'keep'),'preserved');
  await assert.rejects(packageMacArtifact(args,{command:()=>assert.fail('must not execute'),currentHost:mac}),{code:'EEXIST'});assert.equal(await fs.readFile(path.join(f.outputDir,'keep'),'utf8'),'preserved');
});
test('build validates config and host before invoking native tools; child JSON becomes one artifact result',async t=>{
  const f=await fixture(t),options={configPath:f.configPath,outputDir:f.outputDir,target:'macos-arm64'},calls=[];
  const child={target:'macos-arm64',projectRef:ref,version:'0.2.0',appPath:f.app,signing:'adhoc-local-test',signed:true,notarized:false,distributable:false,configured:true};
  const command=async(name,args)=>{calls.push({name,args});return {stdout:name==='/usr/bin/sw_vers'?'15.7.7\n':JSON.stringify(child),stderr:''};};
  const result=await buildMacArtifact(options,{currentHost:mac,command,packageArtifact:async args=>({target:args.target,appPath:args.appPath})});assert.equal(result.appPath,f.app);
  assert.deepEqual(calls[1].args.slice(-5),['--config',f.configPath,'--target','macos-arm64','--mac-local-test']);
  calls.length=0;await assert.rejects(buildMacArtifact(options,{currentHost:{...mac,platform:'linux'},command}));assert.equal(calls.length,0);
  await fs.writeFile(f.configPath,JSON.stringify({...config,publishableKey:'sb_secret_must_never_ship'}));await assert.rejects(buildMacArtifact(options,{currentHost:mac,command}));assert.equal(calls.length,0);
});
