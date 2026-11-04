import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readHostingConfig,checkHosting } from '../scripts/host.mjs';

test('host config requires a private file and a separate HTTPS domain without embedded credentials',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ludy-host-config-')),file=path.join(root,'hosting.json');
 try {
  assert.throws(()=>readHostingConfig(file));
  const write=input=>fs.writeFileSync(file,JSON.stringify(input),{mode:0o600});
  write({publicOrigin:'https://staging.example.com'});assert.deepEqual(readHostingConfig(file),{publicOrigin:'https://staging.example.com'});
  for(const value of [{publicOrigin:'https://ludy-flotte.pages.dev'},{publicOrigin:'https://a.supabase.co'},{publicOrigin:'http://staging.example.com'},{publicOrigin:'https://u:p@staging.example.com'},{publicOrigin:'https://staging.example.com',serviceKey:'forbidden'}]){write(value);assert.throws(()=>readHostingConfig(file));}
  write({publicOrigin:'https://staging.example.com'});fs.chmodSync(file,0o644);assert.throws(()=>readHostingConfig(file));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('host startup refuses unverified local development keys before contacting the application',async()=>{
 let requests=0;
 const common={loadRuntime:()=>({projectId:'ludy-staging',anonKey:'public'}),loadConfig:()=>({publicOrigin:'https://staging.example.com'}),fetchFn:async()=>{requests++;return Response.json({environment:'staging',project:'ludy-staging'});}};
 await assert.rejects(checkHosting({...common,verify:async()=>{throw Error('Development defaults refused');}}));assert.equal(requests,0);
 await assert.rejects(checkHosting({...common,verify:async()=>({ok:false,projectId:'ludy-staging'})}));assert.equal(requests,0);
 const result=await checkHosting({...common,verify:async()=>({ok:true,projectId:'ludy-staging'})});assert.equal(result.runtime.anonKey,'public');assert.equal(requests,1);
 await assert.rejects(checkHosting({...common,verify:async()=>({ok:true,projectId:'ludy-staging'}),fetchFn:async()=>Response.json({environment:'production',project:'flotte'})}));
});
