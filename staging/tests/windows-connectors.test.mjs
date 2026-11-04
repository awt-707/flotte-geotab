import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initializePrivateRoot} from '../server/private-files.mjs';
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
  const result=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,LUDY_TEST_CREDENTIAL:file},windowsHide:true,timeout:20000});
  const acl=JSON.parse(result.stdout);assert.ok(acl.entries.length>=2);assert.deepEqual(new Set(acl.entries.map(x=>x.sid)),new Set([acl.current,'S-1-5-18']));assert.ok(acl.entries.every(x=>x.type==='Allow'&&x.inherited===true));
  assert.deepEqual(await fs.readdir(root),['bolt.env']);
});
