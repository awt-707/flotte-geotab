import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD} from '../scripts/import-reference.mjs';
import {localRunner} from './prepare-local-rehearsal.mjs';
assertLocalProject();if(process.argv.length!==2)throw Error('No connection options accepted.');
const database='promotion_test_'+randomUUID().replaceAll('-',''),sql=localRunner(database);
const source=await fs.readFile(new URL('./verify-deployment-editor.sql',import.meta.url),'utf8');
function check(){const out=sql(source+"\nselect 'CLEARED:'||coalesce(current_setting('ludy_deployment_verification.result',true),'MISSING');").stdout.trim().split('\n');assert.equal(out.at(-1),'CLEARED:');const row=out.find(v=>/^[tf]\|/.test(v));assert.ok(row);return{ok:row[0]==='t',checks:JSON.parse(row.slice(2))};}
let created=false;
try{
 sql('begin read only;'+LOCAL_GUARD+'rollback;',{admin:true,control:true});
 sql(`create database "${database}" owner postgres template template0;`,{admin:true,control:true});created=true;
 let result=check();assert.equal(result.ok,false);assert.equal(result.checks.readOnly,true);assert.ok(result.checks.desktopTables.every(t=>!t.present));assert.ok(result.checks.desktopRpcs.every(t=>!t.present));
 sql(`create table public.params(key text primary key,value text);insert into public.params values('environment','production');
 create schema desktop_worker_private;revoke all on schema desktop_worker_private from public,anon,authenticated,service_role;
 create table public.desktop_worker_devices(id uuid);create table public.desktop_worker_leases(id uuid);create table public.desktop_vehicle_live(id uuid);
 alter table public.desktop_worker_devices enable row level security;alter table public.desktop_worker_leases enable row level security;alter table public.desktop_vehicle_live enable row level security;
 revoke all on public.desktop_worker_devices,public.desktop_worker_leases,public.desktop_vehicle_live from public,anon,authenticated,service_role;
 grant select on public.desktop_vehicle_live to authenticated;
 create policy read_vehicle on public.desktop_vehicle_live for select to authenticated using(true);`);
 const signatures=['desktop_worker_register(uuid,text,boolean)','desktop_worker_status(uuid)','desktop_worker_claim(uuid)','desktop_worker_renew(uuid,bigint)','desktop_worker_release(uuid,bigint)','desktop_worker_request(uuid,bigint,text,text,jsonb,jsonb,text)','desktop_admin_request(uuid,text,text,jsonb,jsonb,text)','desktop_manager_request(text,text,jsonb,jsonb,text)'];
 for(const signature of signatures)sql(`create function public.${signature} returns jsonb language sql security definer as $$select '{}'::jsonb$$;revoke all on function public.${signature} from public,anon,authenticated,service_role;grant execute on function public.${signature} to authenticated;`);
 result=check();assert.equal(result.ok,true);assert.equal(result.checks.desktopRpcs.length,8);assert.equal(result.checks.desktopTables.length,3);
 sql('grant execute on function public.desktop_worker_claim(uuid) to anon;');result=check();assert.equal(result.ok,false);assert.equal(result.checks.desktopRpcs.find(r=>r.signature==='public.desktop_worker_claim(uuid)').permissionsOk,false);
 sql('revoke execute on function public.desktop_worker_claim(uuid) from anon;alter table public.desktop_vehicle_live disable row level security;');result=check();assert.equal(result.ok,false);assert.equal(result.checks.desktopTables.find(t=>t.name==='public.desktop_vehicle_live').rls,false);
 console.log(JSON.stringify({ok:true,checks:13,readOnly:true,finalResultRow:true,missingObjectsReturnFalse:true,grantsDriftDetected:true,rlsDriftDetected:true,sessionCleared:true,remoteConnections:0}));
}finally{if(created)sql(`drop database "${database}" with(force);`,{admin:true,control:true});}
