// Explicit local smoke: real staging schema/data, reads only after local login.
// No provider request, account creation, notification, migration or source sync.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Readable} from 'node:stream';
import {readRuntime} from '../scripts/guard.mjs';
import {createOperationsApi} from '../server/operations.mjs';

const runtime=readRuntime();
const credentials=JSON.parse(await fs.readFile(new URL('../.local/credentials.json',import.meta.url),'utf8'));
assert.equal(credentials.environment,'staging-local-only');
const response=await fetch(runtime.supabaseUrl+'/auth/v1/token?grant_type=password',{
 method:'POST',headers:{apikey:runtime.anonKey,'Content-Type':'application/json'},
 body:JSON.stringify({email:credentials.email,password:credentials.password}),
 redirect:'error',signal:AbortSignal.timeout(10000)
});
assert.ok(response.ok,'Local administrator sign-in failed');
const session=await response.json(),reads=[];
const api=createOperationsApi({supabaseUrl:runtime.supabaseUrl,anonKey:runtime.anonKey,serviceKey:runtime.serviceKey,
 fetchFn:(url,options={})=>{
  const u=new URL(url);assert.equal(u.origin,runtime.supabaseUrl,'Local Supabase only');
  assert.equal(options.method||'GET','GET','The rotations endpoint is read-only');
  reads.push(u.pathname);return fetch(url,options);
 },notify(){assert.fail('No notification during a rotation report');},setTimer(){assert.fail('No provider polling during a rotation report');}
});
try{
 const request=Readable.from([]);Object.assign(request,{url:'/api/operations/rotations',method:'GET',headers:{host:'127.0.0.1:4173',origin:'http://127.0.0.1:4173',authorization:'Bearer '+session.access_token},socket:{remoteAddress:'127.0.0.1'}});
 let status,data;const started=Date.now();
 assert.equal(await api(request,{writeHead:value=>status=value,end:value=>data=JSON.parse(value)}),true);
 assert.equal(status,200,'Rotations must remain available with the populated local schema');
 assert.ok(Array.isArray(data.rows)&&Array.isArray(data.batches)&&Array.isArray(data.agencies));
 assert.ok(data.rows.every(row=>['measured','estimated','waiting','unknown','conflict'].includes(row.status)));
 assert.ok(data.batches.every(batch=>batch.departed<=batch.total_vehicles&&batch.returned<=batch.total_vehicles));
 assert.ok(Date.now()-started<15000,'The report must fit within the UI request deadline');
 console.log(JSON.stringify({ok:true,milliseconds:Date.now()-started,localReads:reads.length,measured:data.summary.measured_count,unknown:data.summary.unknown_count,observationCoverageComplete:data.coverage.observation_coverage_complete,providerRequests:0,writes:0}));
}finally{api.close();}
