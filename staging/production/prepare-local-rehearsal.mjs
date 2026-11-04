import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {loadManifest,verifySources,parseInventory,REPOSITORY} from './migrations-plan.mjs';

const ENV=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const INVENTORY=path.join(REPOSITORY,'staging/.local/production/production-inventory-2026-11-04.json');
const OUT=path.join(REPOSITORY,'staging/.local/production/preparation');
export const keyOf=(category,o)=>[o.schema||'',o.table||'',o.name||'',category==='functions'?o.identityArguments||'':''].join('|');
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export function compareCatalogs(expected,actual){
 const result={};
 for(const category of ['relations','functions','policies','triggers','indexes','publications']){
  const scope=o=>o.schema==='public'||category==='triggers'&&o.schema==='auth'&&o.name==='on_auth_user_created';
  const a=new Map(expected.catalogs[category].filter(scope).map(o=>[keyOf(category,o),o]));
  const b=new Map(actual.catalogs[category].filter(scope).map(o=>[keyOf(category,o),o]));
  result[category]={expected:a.size,reconstructed:b.size,missing:[],extra:[],changed:[]};
  for(const [key,value] of a){
   if(!b.has(key)){result[category].missing.push(key);continue;}
   const other=b.get(key);if(canonical(value)!==canonical(other))result[category].changed.push({key,fields:[...new Set([...Object.keys(value),...Object.keys(other)])].filter(k=>canonical(value[k])!==canonical(other[k]))});
  }
  for(const key of b.keys())if(!a.has(key))result[category].extra.push(key);
 }
 return result;
}

// Disposable dependency fixtures only. No Auth accounts, Storage files, provider
// credentials, production business rows or staging demo seed are copied.
export const DEPENDENCIES=`
create schema auth;create schema storage;create schema extensions;
create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role')$$;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
create table storage.buckets(id text primary key,name text,public boolean);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets,name text,owner_id text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
create publication supabase_realtime;
grant usage on schema public,auth,storage to anon,authenticated,service_role;
alter default privileges for role postgres in schema public grant all on tables to postgres,anon,authenticated,service_role;
alter default privileges for role postgres in schema public grant all on sequences to postgres,anon,authenticated,service_role;
alter default privileges for role postgres in schema public grant all on functions to postgres,anon,authenticated,service_role;
`;

export function localRunner(database){
 if(!/^promotion_test_[a-f0-9]{32}$/.test(database))throw Error('Disposable database name required.');
 return (sql,{admin=false,control=false,timeout=60000}={})=>{
  const args=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(v=>v==='--username=postgres'&&admin?'--username=supabase_admin':v==='--dbname=postgres'&&!control?'--dbname='+database:v);
  const r=spawnSync('docker',args,{input:sql,env:ENV,encoding:'utf8',timeout,maxBuffer:8*1024*1024});
  if(r.error||r.status!==0){const e=Error('Disposable local SQL failed.');e.diagnostic=String(r.stderr||r.error);throw e;}
  return {stdout:r.stdout,stderr:r.stderr};
 };
}

export async function rehearse({variants=null,beforeMigrations=null,beforeVariant=null,afterMigrations=null,atomicBundle=null,baselineAdjustments=null,initializeLocalMarker=true}={}){
 assertLocalProject();
 const manifest=await loadManifest();await verifySources(REPOSITORY,manifest);
 const production=parseInventory(await fs.readFile(INVENTORY,'utf8'));
 await fs.mkdir(OUT,{recursive:true,mode:0o700});await fs.chmod(OUT,0o700);
 await fs.rm(path.join(OUT,'rehearsal-error.log'),{force:true});
 const save=async(name,data)=>fs.writeFile(path.join(OUT,name),typeof data==='string'?data:JSON.stringify(data,null,2)+'\n',{mode:0o600});
 const database='promotion_test_'+randomUUID().replaceAll('-',''),sql=localRunner(database);
 const report={format:'ludy-local-production-preparation-v1',capturedAt:new Date().toISOString(),readyForProduction:false,remoteConnections:0,variantTransaction:atomicBundle?'single':'per-file',baselineReplayedOnlyInDisposableDatabase:true,baselineApplied:[],variantsApplied:[],dependencyFixtures:['auth.users','auth.uid','auth.role','auth.jwt','storage.buckets','storage.objects','storage.foldername'],limits:['No production rows, Auth users or Storage objects restored','No backup/restore rehearsal','Remote function bodies unavailable; only inventory MD5 compared','External services and old writers not exercised'],blockers:[]};
 let created=false;
 try{
  sql('begin read only;'+LOCAL_GUARD+'rollback;',{admin:true,control:true});
  sql(`create database "${database}" owner postgres template template0;`,{admin:true,control:true});created=true;
  sql('set role postgres;'+DEPENDENCIES,{admin:true});
  for(const entry of manifest.baseline){sql('begin;'+await fs.readFile(path.join(REPOSITORY,'supabase/migrations',entry.file),'utf8')+'\ncommit;');report.baselineApplied.push(entry.file);}
  if(baselineAdjustments){
   report.reviewedBaselineAdjustments=await baselineAdjustments(sql);
   report.limits=report.limits.filter(v=>v!=='Remote function bodies unavailable; only inventory MD5 compared');
   report.limits.push('Two reviewed remote definitions restored; other business definitions checked against inventory MD5. Auth/Storage dependency fixtures remain synthetic.');
  }
  const inventorySql=await fs.readFile(path.join(REPOSITORY,'staging/production/migrations-inventory.sql'),'utf8');
  const baseline=parseInventory(sql(inventorySql).stderr);
  await save('baseline-inventory.json',baseline);
  report.serverVersion=baseline.serverVersion;report.productionServerVersion=production.serverVersion;
  report.comparison=compareCatalogs(production,baseline);
  if(Object.values(report.comparison).some(c=>c.missing.length||c.extra.length||c.changed.length))report.blockers.push('PRODUCTION_SCHEMA_DIFFERS_FROM_RECONSTRUCTED_BASELINE');
  if(variants){
   if(initializeLocalMarker)sql("insert into public.params(key,value) values('environment','production') on conflict(key) do update set value=excluded.value;");
   if(beforeMigrations)await beforeMigrations(sql,baseline);
   if(atomicBundle){
    const localInventory=parseInventory(sql(inventorySql).stderr);
    const bundle=await atomicBundle(localInventory,inventorySql,variants);
    // Prove that a failure after all the DDL rolls it back as one unit, then
    // apply the identical transaction normally on this disposable database.
    const failure=bundle.replace('\ncommit;','\ndo $test_abort$ begin raise exception \'SYNTHETIC_PROMOTION_ROLLBACK\';end $test_abort$;\ncommit;');
    let refused=false;try{sql(failure);}catch(e){if(!e.diagnostic?.includes('SYNTHETIC_PROMOTION_ROLLBACK'))throw e;refused=true;}
    if(!refused||sql("select to_regclass('public.fleet_sources') is null;").stdout.trim()!=='t')throw Error('Atomic rollback did not preserve the baseline.');
    if(!initializeLocalMarker&&sql("select value is null from public.params where key='environment';").stdout.trim()!=='t')throw Error('Atomic rollback did not restore the original null marker.');
    report.atomicRollbackVerified=true;report.markerInitializationRolledBack=!initializeLocalMarker;sql(bundle);report.variantsApplied=variants.map(v=>v.file);
   }else for(const entry of variants){if(beforeVariant)await beforeVariant(sql,entry);sql('begin;'+entry.sql+'\ncommit;');report.variantsApplied.push(entry.file);}
   if(afterMigrations)report.checks=await afterMigrations(sql);
   const candidate=parseInventory(sql(inventorySql).stderr);await save('candidate-inventory.json',candidate);
   report.migrationEffects=compareCatalogs(baseline,candidate);
  }
  report.blockers.push('REAL_DATA_RESTORE_AND_CUTOVER_NOT_REHEARSED');
 }catch(e){await save('rehearsal-error.log',e.diagnostic||e.stack);report.failure=e.message;report.blockers.push('LOCAL_REHEARSAL_FAILED');}
 finally{if(created){sql(`drop database "${database}" with(force);`,{admin:true,control:true});report.disposableDatabaseDropped=true;}await save(atomicBundle?'rehearsal-atomic-report.json':'rehearsal-report.json',report);}
 return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv.length!==2)throw Error('No connection or execution options accepted.');
 const report=await rehearse();console.log(JSON.stringify({baseline:report.baselineApplied.length,variants:report.variantsApplied.length,blockers:report.blockers,comparison:report.comparison,report:path.join(OUT,'rehearsal-report.json')},null,2));if(report.failure)process.exitCode=1;
}
