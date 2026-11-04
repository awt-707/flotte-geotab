import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initializePrivateRoot,windowsPowerShellEnvironment,privateModeValid} from '../server/private-files.mjs';
import {saveBoltCredentials,readBoltCredentials} from '../server/bolt.mjs';

test('native Windows: inherited owner/SYSTEM ACL protects saved Bolt credentials across replacement',{skip:process.platform!=='win32'},async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ludy-windows-connectors-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const execute=promisify(execFile);
  const {protection}=await initializePrivateRoot(root,{run:async(...args)=>{
    try{return await execute(...args);}catch(error){
      // Only this synthetic fixture exposes native command diagnostics. The
      // application keeps its generic error and never logs private paths/data.
      t.diagnostic('Windows ACL command failed: '+JSON.stringify({code:error.code,signal:error.signal,stderr:String(error.stderr||'').slice(0,8000),stdout:String(error.stdout||'').slice(0,2000)}));
      throw error;
    }
  }});assert.equal(protection,'windows-user-system-acl');
  const file=path.join(root,'bolt.env'),first={clientId:'synthetic-windows',clientSecret:'synthetic-secret'},next={...first,clientSecret:'replacement-secret'};
  await saveBoltCredentials(file,first);assert.deepEqual(await readBoltCredentials(file),first);
  await saveBoltCredentials(file,next);assert.deepEqual(await readBoltCredentials(file),next);
  const script=`$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:LUDY_TEST_CREDENTIAL
$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$entries=@($acl.Access | ForEach-Object { @{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;type=$_.AccessControlType.ToString();inherited=$_.IsInherited} })
@{current=$current;entries=$entries} | ConvertTo-Json -Depth 4 -Compress`;
  const result=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env:{...windowsPowerShellEnvironment(),LUDY_TEST_CREDENTIAL:file},windowsHide:true,timeout:20000});
  const acl=JSON.parse(result.stdout);assert.ok(acl.entries.length>=2);assert.deepEqual(new Set(acl.entries.map(x=>x.sid)),new Set([acl.current,'S-1-5-18']));assert.ok(acl.entries.every(x=>x.type==='Allow'&&x.inherited===true));
  assert.deepEqual(await fs.readdir(root),['bolt.env']);
});

test('native Windows: an exact private ACL is idempotent without requesting Set-Acl privileges',{skip:process.platform!=='win32'},async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ludy-windows-acl-idempotent-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await initializePrivateRoot(root);
  const result=await initializePrivateRoot(root,{run:(command,args,options)=>promisify(execFile)(command,[...args.slice(0,-1),
    "function Set-Acl { throw 'Idempotent initialization must not rewrite the ACL.' }\n"+args.at(-1)],options)});
  assert.equal(result.protection,'windows-user-system-acl');
  assert.equal(privateModeValid(await fs.stat(root),0o700,root),true);
});

test('native Windows: a widened ACL is repaired and ineffective repair fails closed',{skip:process.platform!=='win32'},async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ludy-windows-acl-repair-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const execute=promisify(execFile);
  const widened=`$ErrorActionPreference='Stop'
$directory=$env:LUDY_PRIVATE_DIRECTORY
$acl=Get-Acl -LiteralPath $directory
$extra=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($extra,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $directory -AclObject $acl`;
  const widen=()=>execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',widened],{env:{...windowsPowerShellEnvironment(),LUDY_PRIVATE_DIRECTORY:root},windowsHide:true,timeout:20000});
  await initializePrivateRoot(root);await widen();
  await assert.rejects(initializePrivateRoot(root,{run:(command,args,options)=>execute(command,[...args.slice(0,-1),
    'function Set-Acl { }\n'+args.at(-1)],options)}),{code:'PRIVATE_STORAGE_UNAVAILABLE'});
  assert.equal(privateModeValid(await fs.stat(root),0o700,root),false,'failed revalidation revokes the previously authorized root');
  await initializePrivateRoot(root);
  // This succeeds only if the repaired ACL passes every native validation and
  // the second call needs no attempt to modify the permissions again.
  await initializePrivateRoot(root,{run:(command,args,options)=>execute(command,[...args.slice(0,-1),
    "function Set-Acl { throw 'Repair did not produce the exact private ACL.' }\n"+args.at(-1)],options)});
  assert.equal(privateModeValid(await fs.stat(root),0o700,root),true);
});
