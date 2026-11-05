import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFleetApi} from '../server/fleet.mjs';
import {sourceKey} from '../server/fleet-domain.mjs';
import {initializePrivateRoot} from '../server/private-files.mjs';
import {saveBoltCredentials} from '../server/bolt.mjs';

const AT=Date.parse('2026-11-05T10:00:00Z'),stamp=delta=>new Date(AT+delta).toISOString();
const sample=(id,delta=0,extra={})=>({sourceId:id,name:'Synthetic '+id,organizationId:'org-a',state:'offline',readAt:stamp(delta),...extra});

async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ludy-fleet-batch-')));await initializePrivateRoot(root);
 t.after(()=>rm(root,{recursive:true,force:true}));const boltEnvPath=join(root,'bolt.env');
 await saveBoltCredentials(boltEnvPath,{clientId:'synthetic-id',clientSecret:'synthetic-secret'});
 const tables={profiles:[{user_id:'admin',role:'admin'}],fleet_sources:['uber','bolt','geotab','myclicar'].map(id=>({id,status:'healthy',stale_after_s:180,last_success_at:stamp(-1000),metadata:{}})),fleet_settings:[{id:1,enabled:false}],fleet_identities:[],fleet_drivers:[],fleet_latest:[],fleet_observations:[]};
 const requests=[];let rows=[],sequence=0,failTable=null,clock=AT;
 function seed(input,{source='bolt',previousAt=-30000,status='offline',samples=2}={}){
  const id=source+'-'+(++sequence),driver_id='driver-'+id;
  tables.fleet_identities.push({id,driver_id,source,source_key:sourceKey(input.organizationId,input.sourceId,input.name),organization_id:input.organizationId,external_id:input.sourceId,provisional:!input.sourceId});
  tables.fleet_drivers.push({id:driver_id,name:input.name});
  tables.fleet_latest.push({identity_id:id,driver_id,source,status,observed_at:stamp(previousAt),offline_since:stamp(-60000),offline_samples:samples,recovery_samples:0,evidence:{}});
  return id;
 }
 const fetchFn=async(url,options={})=>{
  const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:57421');
  if(u.pathname==='/auth/v1/user')return Response.json({id:'admin'});
  const table=u.pathname.split('/').at(-1),method=options.method||'GET',params=Object.fromEntries(u.searchParams),body=options.body===undefined?null:JSON.parse(options.body);
  requests.push({table,method,params,body});
  // Matching is a separate subsystem; its failure must not affect ingestion.
  if(u.pathname.includes('/rpc/'))return Response.json({}, {status:503});
  if(table===failTable&&method==='POST')return Response.json({}, {status:503});
  const items=tables[table]??=([]),matches=row=>Object.entries(params).every(([key,value])=>{
   if(value.startsWith('eq.'))return String(row[key])===value.slice(3);
   if(value.startsWith('in.('))return value.slice(4,-1).split(',').includes(String(row[key]));
   return true;
  });
  if(method==='GET'){
   const offset=Number(params.offset||0),limit=Number(params.limit||1000);
   return Response.json(items.filter(matches).slice(offset,offset+limit));
  }
  if(method==='PATCH'){const changed=items.filter(matches);for(const row of changed)Object.assign(row,body);return Response.json(changed);}
  assert.equal(method,'POST');const written=[];
  for(const row of Array.isArray(body)?body:[body]){
   const keys=(params.on_conflict||'').split(',').filter(Boolean),old=keys.length&&items.find(item=>keys.every(key=>item[key]===row[key]));
   if(old){if(!options.headers.Prefer?.includes('ignore-duplicates'))Object.assign(old,row);written.push(old);}
   else{const saved={id:'created-'+(++sequence),...row};items.push(saved);written.push(saved);}
  }
  return Response.json(written);
 };
 class Bolt{async snapshot(){return {rows:structuredClone(rows),vehicles:[],companies:[],at:new Date(clock).toISOString()};}}
 const handler=createFleetApi({supabaseUrl:'http://127.0.0.1:57421',serviceKey:'synthetic-service',anonKey:'synthetic-anon',boltEnvPath,fetchFn,Bolt,now:()=>clock});t.after(()=>handler.close());
 const refresh=async input=>{
  rows=input;const req=Readable.from([Buffer.from('{}')]);Object.assign(req,{url:'/api/fleet/bolt/refresh',method:'POST',headers:{host:'127.0.0.1:4173',authorization:'Bearer admin'},socket:{remoteAddress:'127.0.0.1'}});
  let code,value;await handler(req,{writeHead:status=>{code=status;},end:json=>{value=JSON.parse(json);},setHeader(){}});return {code,value};
 };
 return {tables,requests,seed,refresh,fail:value=>{failTable=value;},advance:delta=>{clock+=delta;}};
}

test('a known roster uses bulk persistence and keeps provider and organization identities separate',async t=>{
 const f=await fixture(t),rows=Array.from({length:16},(_,i)=>sample('account-'+i)),ids=rows.map(row=>f.seed(row));
 const foreign=f.seed(rows[0],{source:'uber'}),otherOrg=f.seed({...rows[0],organizationId:'org-b'}),untouched=structuredClone(f.tables.fleet_latest.filter(row=>[foreign,otherOrg].includes(row.identity_id)));
 const result=await f.refresh(rows);assert.equal(result.code,200);assert.equal(result.value.observations,16);
 const persistence=f.requests.slice(0,f.requests.findIndex(r=>r.table==='fleet_sources'&&r.method==='PATCH'&&r.body?.status==='healthy'));
 assert.equal(persistence.filter(r=>r.method==='GET'&&['fleet_identities','fleet_latest'].includes(r.table)).length,2,'one snapshot per table replaces per-driver reads');
 for(const read of persistence.filter(r=>r.method==='GET'&&['fleet_identities','fleet_latest'].includes(r.table)))assert.equal(read.params.source,'eq.bolt');
 const writes=persistence.filter(r=>r.method==='POST'&&['fleet_observations','fleet_latest'].includes(r.table));
 assert.deepEqual(writes.map(r=>[r.table,r.body.length]),[['fleet_observations',16],['fleet_latest',16]]);
 assert.deepEqual(f.tables.fleet_observations.map(row=>row.identity_id),ids);
 assert.ok(f.tables.fleet_latest.filter(row=>ids.includes(row.identity_id)).every(row=>row.offline_samples===3&&row.offline_since===stamp(-60000)));
 assert.deepEqual(f.tables.fleet_latest.filter(row=>[foreign,otherOrg].includes(row.identity_id)),untouched);
});

test('repeated identities retain ordered observations and counters while equal or older readings are ignored',async t=>{
 const f=await fixture(t),known=sample('known'),id=f.seed(known);
 const fresh=sample(null,-15000,{name:'New Synthetic Driver'});
 const rows=[sample('known',-40000),sample('known',-20000),sample('known',-20000,{state:'available'}),sample('known',-25000),sample('known',-10000),sample('known',0),fresh,{...fresh,readAt:stamp(-5000)}];
 const result=await f.refresh(rows);assert.equal(result.code,200);assert.equal(result.value.observations,5);
 assert.deepEqual(f.tables.fleet_observations.filter(row=>row.identity_id===id).map(row=>row.observed_at),[stamp(-20000),stamp(-10000),stamp(0)]);
 const latest=f.tables.fleet_latest.find(row=>row.identity_id===id);assert.equal(latest.offline_samples,5);assert.equal(latest.offline_since,stamp(-60000));assert.equal(latest.observed_at,stamp(0));
 const created=f.tables.fleet_identities.filter(row=>row.id!==id);assert.equal(created.length,1);assert.equal(created[0].source_key,sourceKey('org-a',null,fresh.name));assert.equal(created[0].provisional,true);
 assert.equal(f.tables.fleet_latest.find(row=>row.identity_id===created[0].id).offline_samples,2);
 assert.equal(f.requests.filter(r=>r.table==='fleet_identities'&&r.method==='POST').length,1,'the second row reuses the newly created identity');
 const latestWrites=f.requests.filter(r=>r.table==='fleet_latest'&&r.method==='POST');assert.equal(latestWrites.length,1);assert.equal(latestWrites[0].body.length,2,'a bulk upsert never repeats its conflict key');
});

test('large provider rosters paginate snapshots and stay within the 1000-row desktop write limit',async t=>{
 const f=await fixture(t),rows=Array.from({length:1001},(_,i)=>sample('large-'+i));rows.forEach(row=>f.seed(row));
 const result=await f.refresh(rows);assert.equal(result.code,200);assert.equal(result.value.observations,1001);
 for(const table of ['fleet_observations','fleet_latest'])assert.deepEqual(f.requests.filter(r=>r.table===table&&r.method==='POST').map(r=>r.body.length),[1000,1]);
 assert.equal(f.tables.fleet_observations.length,1001);assert.equal(f.tables.fleet_latest.at(-1).observed_at,stamp(0));
 assert.equal(f.requests.filter(r=>r.table==='fleet_identities'&&r.method==='POST').length,0,'identities beyond the first page are retained');
});

for(const failing of ['fleet_observations','fleet_latest'])test('a failed '+failing+' batch never reports healthy success and a retry is idempotent',async t=>{
 const f=await fixture(t),row=sample('retry'),id=f.seed(row),previous=structuredClone(f.tables.fleet_latest[0]);f.fail(failing);
 const failed=await f.refresh([row]);assert.equal(failed.code,502);assert.equal(f.tables.fleet_sources.find(row=>row.id==='bolt').status,'error');
 assert.equal(f.tables.fleet_latest.find(row=>row.identity_id===id).observed_at,previous.observed_at);
 assert.equal(f.tables.fleet_observations.length,failing==='fleet_observations'?0:1);
 assert.ok(!f.requests.some(r=>r.table==='fleet_sources'&&r.body?.status==='healthy'));
 f.fail(null);f.advance(61000);const retry=await f.refresh([row]);assert.equal(retry.code,200);assert.equal(retry.value.observations,1);
 assert.equal(f.tables.fleet_observations.length,1);assert.equal(f.tables.fleet_latest[0].observed_at,stamp(0));assert.equal(f.tables.fleet_latest[0].offline_samples,1,'an interrupted source cannot retain offline continuity');
});
