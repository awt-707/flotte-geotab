import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {initializePrivateRoot,privateModeValid,syncPrivateDirectory,ensurePrivateDirectory,readPrivateJson,writePrivateJson,WINDOWS_PRIVATE_ACL_SCRIPT,windowsPowerShellEnvironment} from '../server/private-files.mjs';

test('Windows PowerShell child resets inherited module paths case-insensitively without changing its parent',()=>{
  const inherited={Path:'C:\\Windows\\System32',SystemRoot:'C:\\Windows',PSModulePath:'C:\\Program Files\\PowerShell\\7\\Modules',pSmOdUlEpAtH:'C:\\PS7',LUDY_PRIVATE_DIRECTORY:'C:\\Users\\Example\\private'};
  const before={...inherited},child=windowsPowerShellEnvironment(inherited);
  assert.deepEqual(child,{Path:inherited.Path,SystemRoot:inherited.SystemRoot,LUDY_PRIVATE_DIRECTORY:inherited.LUDY_PRIVATE_DIRECTORY});
  assert.deepEqual(inherited,before);
});

test('POSIX private files retain strict modes, atomic replacement and symlink rejection',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-private-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await initializePrivateRoot(root);assert.equal((await fs.stat(root)).mode&0o777,0o700);
  const directory=path.join(root,'nested'),file=path.join(directory,'ledger.json');await ensurePrivateDirectory(directory);
  assert.equal(await readPrivateJson(file),null);await writePrivateJson(file,{value:1});assert.deepEqual(await readPrivateJson(file),{value:1});
  await writePrivateJson(file,{value:2});assert.deepEqual(await readPrivateJson(file),{value:2});assert.equal((await fs.stat(file)).mode&0o777,0o600);
  await fs.chmod(file,0o644);await assert.rejects(readPrivateJson(file));await fs.chmod(file,0o600);
  const link=path.join(directory,'redirect.json');await fs.symlink(file,link);await assert.rejects(readPrivateJson(link));await assert.rejects(writePrivateJson(link,{value:3}));
  assert.deepEqual(await readPrivateJson(file),{value:2});await assert.rejects(writePrivateJson(file,{value:'large'},{maxBytes:5}));
  await syncPrivateDirectory(directory);
});
test('Windows mode handling requires a successfully protected root and never accepts neighbouring paths',async()=>{
  const directory='C:\\Users\\Tester\\AppData\\Roaming\\Ludy\\private-test',calls=[];
  const files={mkdir:async()=>{},lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false,mode:0o777}),realpath:async()=>directory};
  const weak={mode:0o666};assert.equal(privateModeValid(weak,0o600,directory+'\\token.json',{platform:'win32'}),false);
  await initializePrivateRoot(directory,{platform:'win32',files,run:async(...args)=>calls.push(args)});
  assert.equal(calls[0][0],'powershell.exe');assert.equal(calls[0][1].at(-1),WINDOWS_PRIVATE_ACL_SCRIPT);assert.equal(calls[0][2].env.LUDY_PRIVATE_DIRECTORY,directory);
  assert.ok(!WINDOWS_PRIVATE_ACL_SCRIPT.includes(directory));assert.match(WINDOWS_PRIVATE_ACL_SCRIPT,/SetAccessRuleProtection\(\$true, \$false\)/);assert.match(WINDOWS_PRIVATE_ACL_SCRIPT,/S-1-5-18/);
  assert.equal(privateModeValid(weak,0o600,directory+'\\token.json',{platform:'win32'}),true);
  assert.equal(privateModeValid(weak,0o600,directory+'-outside\\token.json',{platform:'win32'}),false);
  assert.equal(privateModeValid(weak,0o600,directory+'\\..\\token.json',{platform:'win32'}),false);
  await syncPrivateDirectory(directory,{platform:'win32',files:{open:()=>assert.fail('Windows cannot sync directories through Node')}});
  await assert.rejects(syncPrivateDirectory('C:\\outside',{platform:'win32'}));
  assert.equal(privateModeValid(weak,0o600,directory+'\\token.json',{platform:'linux'}),false);
});
test('Windows ACL failure and redirected root never authorize private-file mode checks',async()=>{
  const directory='C:\\Users\\Tester\\AppData\\Roaming\\Ludy\\failed-test';
  const files={mkdir:async()=>{},lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false}),realpath:async()=>directory};
  await assert.rejects(initializePrivateRoot(directory,{platform:'win32',files,run:async()=>{throw Error('ACL unavailable');}}));
  assert.equal(privateModeValid({mode:0o666},0o600,directory+'\\token.json',{platform:'win32'}),false);
  await assert.rejects(initializePrivateRoot(directory,{platform:'win32',files:{...files,realpath:async()=>'C:\\outside'},run:async()=>assert.fail('must reject redirect first')}));
});

test('failed Windows revalidation revokes a previously authorized private root',async()=>{
  const directory='C:\\Users\\Tester\\AppData\\Roaming\\Ludy\\revalidation-test';
  const files={mkdir:async()=>{},lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false}),realpath:async()=>directory};
  await initializePrivateRoot(directory,{platform:'win32',files,run:async()=>{}});
  assert.equal(privateModeValid({mode:0o666},0o600,directory+'\\token.json',{platform:'win32'}),true);
  await assert.rejects(initializePrivateRoot(directory,{platform:'win32',files,run:async()=>{throw Error('ACL could not be verified');}}),{code:'PRIVATE_STORAGE_UNAVAILABLE'});
  assert.equal(privateModeValid({mode:0o666},0o600,directory+'\\token.json',{platform:'win32'}),false);
});
