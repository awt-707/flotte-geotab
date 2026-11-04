import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';

assertLocalProject();
if(process.argv.length!==2)throw Error('No connection options are accepted.');
const database='worker_test_'+randomUUID().replaceAll('-','');
assert.match(database,/^worker_test_[a-f0-9]{32}$/);
const actor=randomUUID(),devices=Array.from({length:4},()=>randomUUID());
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const q=x=>"'"+String(x).replaceAll("'","''")+"'";
function args(target=database){return dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x==='--dbname=postgres'?'--dbname='+target:x);}
function sync(sql,target=database){const result=spawnSync('docker',args(target),{input:sql,env,encoding:'utf8',timeout:10000,maxBuffer:1048576});if(result.status!==0)throw Error('Disposable desktop SQL failed; no remote target was used.');return result.stdout.trim();}
function asyncSql(sql){return new Promise((resolve,reject)=>{const child=spawn('docker',args(),{env,stdio:['pipe','pipe','pipe']});let out='',err='';const timeout=setTimeout(()=>{child.kill();reject(Error('Disposable SQL timed out'));},10000);child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.on('error',e=>{clearTimeout(timeout);reject(e);});child.on('close',code=>{clearTimeout(timeout);resolve({code,out:out.trim(),err});});child.stdin.end(sql);});}
const auth=`set role authenticated;set request.jwt.claim.sub=${q(actor)};set request.jwt.claims=${q(JSON.stringify({sub:actor,role:'authenticated'}))};`;
let created=false;
try{
 // Only this explicit local-container socket is used. The production and live
 // staging databases receive no DDL or fixtures, including during concurrency.
 sync('begin read only;'+LOCAL_GUARD+'rollback;','postgres');
 sync(`create database "${database}" template template0;`,'postgres');created=true;
 sync(`create schema auth;create table auth.users(id uuid primary key);create table public.profiles(user_id uuid primary key references auth.users,role text);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claims',true)::jsonb->>'role'$$;
 create function public.is_admin() returns boolean language sql stable security definer as $$select coalesce((select role='admin' from public.profiles where user_id=auth.uid()),false)$$;
 create table public.ops_fuel_checkpoints(vehicle_key text primary key,state jsonb,updated_at timestamptz);
 insert into auth.users values(${q(actor)});insert into public.profiles values(${q(actor)},'admin');
 ${readFileSync(new URL('../production/desktop-workers.sql',import.meta.url),'utf8')}
 ${auth}${devices.map(id=>`select public.desktop_worker_register(${q(id)},'Synthetic concurrent PC',true);`).join('\n')}`);
 const races=await Promise.all(devices.map(id=>asyncSql(auth+`select public.desktop_worker_claim(${q(id)});`)));
 assert.ok(races.every(r=>r.code===0));
 const states=races.map(r=>JSON.parse(r.out));assert.equal(states.filter(r=>r.lease.owned).length,1);
 const holder=states.find(r=>r.lease.owned),next=devices.find(id=>id!==holder.device.id);
 assert.equal(holder.lease.fence,1);
 sync(`create function public.worker_test_delay() returns trigger language plpgsql as $$begin perform pg_sleep(1.8);return new;end$$;
 create trigger worker_test_delay before insert on public.ops_fuel_checkpoints for each row execute function public.worker_test_delay();
 update public.desktop_worker_leases set expires_at=clock_timestamp()+interval '1 second' where scope='workspace';`);
 const writing=asyncSql(`set application_name='desktop_fenced_writer';${auth}select public.desktop_worker_request(${q(holder.device.id)},1,'ops_fuel_checkpoints','POST','{}','{"vehicle_key":"synthetic","state":{},"updated_at":"2026-11-04T00:00:00Z"}',null);`);
 let inside=false;
 for(let attempt=0;attempt<30;attempt++){
  inside=sync("select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='desktop_fenced_writer' and wait_event='PgSleep');")==='t';
  if(inside)break;await pause(20);
 }
 assert.ok(inside,'writer reaches its business operation while holding the lease');
 await pause(1100);
 const started=Date.now();
 const takingOver=asyncSql(auth+`select public.desktop_worker_claim(${q(next)});`);
 // A second connection cannot cross the in-flight transaction's row lock.
 await pause(80);
 assert.equal(sync("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%desktop_worker_claim%');"),'t');
 const [oldWrite,takeover]=await Promise.all([writing,takingOver]);
 assert.notEqual(oldWrite.code,0);assert.match(oldWrite.err,/Desktop lease expired during operation/);
 assert.equal(takeover.code,0);const winner=JSON.parse(takeover.out);
 assert.equal(winner.lease.owned,true);assert.equal(winner.lease.fence,2);assert.ok(Date.now()-started>=400);
 assert.equal(sync('select count(*) from public.ops_fuel_checkpoints;'),'0','expired write was rolled back before takeover');
 const stale=await asyncSql(auth+`select public.desktop_worker_request(${q(holder.device.id)},1,'ops_fuel_checkpoints','POST','{}','{"vehicle_key":"stale","state":{},"updated_at":"2026-11-04T00:00:00Z"}',null);`);
 assert.notEqual(stale.code,0);assert.match(stale.err,/Desktop lease lost/);
 console.log(JSON.stringify({ok:true,checks:12,concurrentClaimants:4,activeOwners:1,takeoverWaited:true,expiredWriteRolledBack:true,isolatedDatabase:true}));
}finally{if(created)sync(`drop database "${database}" with(force);`,'postgres');}
