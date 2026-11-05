// Run: node staging/tests/geotab-writer-delegation.integration.mjs
// Uses ONLY the fixed local Supabase container socket and a disposable database.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';

assertLocalProject();
if(process.argv.length!==2)throw Error('No connection options are accepted.');
const database='geotab_guard_test_'+randomUUID().replaceAll('-','');
assert.match(database,/^geotab_guard_test_[a-f0-9]{32}$/);
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const q=x=>"'"+String(x).replaceAll("'","''")+"'";
const migrationDirectory=new URL('../supabase/migrations/',import.meta.url);
const migrationFiles=readdirSync(migrationDirectory).filter(name=>/^\d+_ludy_geotab_writer_delegation\.sql$/.test(name));
assert.equal(migrationFiles.length,1,'one reviewed delegation migration');
const migration=readFileSync(new URL(migrationFiles[0],migrationDirectory),'utf8');
const actor=randomUUID(),device=randomUUID();
const service="set role service_role;set request.jwt.claims='{\"role\":\"service_role\"}';";
const authenticated=`set role authenticated;set request.jwt.claim.sub=${q(actor)};set request.jwt.claims=${q(JSON.stringify({sub:actor,role:'authenticated'}))};`;
const activate=readFileSync(new URL('../production/activate-geotab-desktop.sql',import.meta.url),'utf8');
const restore=readFileSync(new URL('../production/return-geotab-to-legacy.sql',import.meta.url),'utf8');
const withFailure=sql=>{assert.equal((sql.match(/^commit;/gm)||[]).length,1);return sql.replace(/^commit;/m,'select 1/0;commit;');};
const snapshot="select md5(coalesce(string_agg(key||'|'||coalesce(geotab_id,'<null>')||'|'||coalesce(geotab_name,'<null>'),'\\n' order by key),'')) from public.vehicles;";
let checks=0,created=false;
function args(target=database){return dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x==='--dbname=postgres'?'--dbname='+target:x);}
function raw(sql,target=database){return spawnSync('docker',args(target),{input:sql,env,encoding:'utf8',timeout:15000,maxBuffer:1048576});}
function sync(sql,target=database){const r=raw(sql,target);if(r.status!==0)throw Error('Disposable Geotab SQL failed: '+r.stderr.slice(-4000));return r.stdout.trim();}
function check(sql,label){assert.equal(sync('select ('+sql+');'),'t',label);checks++;}
function equal(actual,expected,label){assert.equal(actual,expected,label);checks++;}
function reject(sql,pattern){const r=raw(sql);assert.notEqual(r.status,0);assert.match(r.stderr,pattern);checks++;}
function asyncSql(sql){return new Promise((resolve,rejectPromise)=>{const child=spawn('docker',args(),{env,stdio:['pipe','pipe','pipe']});let out='',err='';const timeout=setTimeout(()=>{child.kill();rejectPromise(Error('Disposable SQL timed out'));},15000);child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.on('error',e=>{clearTimeout(timeout);rejectPromise(e);});child.on('close',code=>{clearTimeout(timeout);resolve({code,out:out.trim(),err});});child.stdin.end(sql);});}
function worker(resource,method,params,body,fence=1){return `select public.desktop_worker_request(${q(device)},${fence},${q(resource)},${q(method)},${q(JSON.stringify(params))}::jsonb,${body===undefined?'null':q(JSON.stringify(body))+'::jsonb'},null);`;}
const liveColumns=`vehicle_key text primary key,plate text,model text,state text,speed double precision,since_min double precision,last_pos_at timestamptz,lat double precision,lon double precision,ign_on boolean,driver_name text,contract_num text,km_today double precision,drive_min_today double precision,idle_min_today double precision,fuel_l_today double precision,alerts_today integer,updated_at timestamptz`;

try{
  sync('begin read only;'+LOCAL_GUARD+'rollback;','postgres');
  equal(sync("select current_setting('server_version_num')::integer/10000;",'postgres'),'17','real PostgreSQL 17');
  sync(`create database "${database}" template template0;`,'postgres');created=true;
  sync(`create schema auth;create table auth.users(id uuid primary key);
    create table public.profiles(user_id uuid primary key references auth.users,role text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role')$$;
    create function public.is_admin() returns boolean language sql stable security definer as $$select coalesce((select role='admin' from public.profiles where user_id=auth.uid()),false)$$;
    create table public.vehicles(key text primary key,plate text,brand text,model text,fuel text,vin text,geotab_id text,geotab_name text,tank_l double precision,ref_l100 double precision,revenue double precision,active text,last_sync timestamptz,other_plates text,agency_id bigint,myclicar_external_id text,geotab_auto_link_disabled boolean not null default false,fuel_reference_evidence jsonb);
    create table public.live_status(${liveColumns});
    create table public.guard_test_history(id text primary key,km numeric);
    create table public.guard_test_jobs(id text primary key,state text);
    grant usage on schema public,auth to service_role,authenticated;
    grant select on public.vehicles,public.live_status to authenticated;
    grant select,insert,update,delete on public.vehicles,public.live_status,public.guard_test_history,public.guard_test_jobs to service_role;
    insert into auth.users values(${q(actor)});insert into public.profiles values(${q(actor)},'admin');
    ${readFileSync(new URL('../production/desktop-live.sql',import.meta.url),'utf8')}
    ${readFileSync(new URL('../production/desktop-workers.sql',import.meta.url),'utf8')}
    insert into public.vehicles(key,plate,model,geotab_id,geotab_name,geotab_auto_link_disabled) values('kept','SYNTHETIC','Before','desktop-device','Desktop name',true);
    insert into public.live_status(vehicle_key,speed) values('kept',12);
    insert into public.desktop_vehicle_live(vehicle_key,data) values('kept','{"device_id":"desktop-device","captured_at":"2026-11-05T00:00:00Z"}');
    create function public.guard_test_legacy_rpc() returns jsonb language plpgsql security definer set search_path='' as $$
    begin
      update public.vehicles set model='RPC metadata',geotab_id='legacy-device',geotab_name='Legacy name' where key='kept';
      update public.live_status set speed=99 where vehicle_key='kept';
      insert into public.guard_test_history values('legacy-history',7) on conflict(id) do update set km=excluded.km;
      insert into public.guard_test_jobs values('legacy-job','done') on conflict(id) do update set state=excluded.state;
      return jsonb_build_object('current_user',current_user,'jwt_role',auth.role());
    end$$;
    revoke all on function public.guard_test_legacy_rpc() from public,anon,authenticated;
    grant execute on function public.guard_test_legacy_rpc() to service_role;`);
  const beforeInstall=sync(snapshot);
  sync('begin;'+migration+'rollback;');
  check("to_regprocedure('public.ludy_desktop_geotab_legacy_guard()') is null",'install fully rolls back');
  equal(sync(snapshot),beforeInstall,'install rollback preserves associations');
  sync('begin;'+migration+'commit;');
  check("(select count(*)=2 and bool_and(tgenabled='D') from pg_trigger where tgname in ('ludy_desktop_geotab_vehicle_guard','ludy_desktop_geotab_live_guard'))",'both installed disabled');
  check("not has_function_privilege('authenticated','public.ludy_desktop_geotab_legacy_guard()','EXECUTE') and not has_function_privilege('service_role','public.ludy_desktop_geotab_legacy_guard()','EXECUTE')",'guard not callable by API roles');
  equal(sync(snapshot),beforeInstall,'install preserves associations');

  // Disabled installation is a behavior-preserving prerequisite, not cutover.
  sync(service+`insert into public.vehicles(key,geotab_id,geotab_name) values('disabled','legacy','Legacy');
    insert into public.live_status(vehicle_key,speed) values('disabled',1);
    update public.live_status set speed=2 where vehicle_key='disabled';
    update public.vehicles set geotab_id='legacy2' where key='disabled';`);
  check("(select geotab_id='legacy2' from public.vehicles where key='disabled') and (select speed=2 from public.live_status where vehicle_key='disabled')",'disabled legacy I/U allowed');
  sync(service+"delete from public.live_status where vehicle_key='disabled';delete from public.vehicles where key='disabled';");
  check("not exists(select 1 from public.live_status where vehicle_key='disabled') and not exists(select 1 from public.vehicles where key='disabled')",'disabled legacy deletes allowed');
  equal(sync(snapshot),beforeInstall,'disabled roundtrip associations unchanged');

  reject(withFailure(activate),/division by zero/);
  check("(select bool_and(tgenabled='D') from pg_trigger where tgname in ('ludy_desktop_geotab_vehicle_guard','ludy_desktop_geotab_live_guard'))",'activation error rolls both triggers back');
  sync(activate);
  check("(select count(*)=2 and bool_and(tgenabled='O') from pg_trigger where tgname in ('ludy_desktop_geotab_vehicle_guard','ludy_desktop_geotab_live_guard'))",'atomic activation enables only dedicated guards');
  equal(sync(snapshot),beforeInstall,'activation preserves associations');

  sync(service+`insert into public.live_status(vehicle_key,speed) values('new-legacy',88);
    insert into public.live_status(vehicle_key,speed) values('kept',88) on conflict(vehicle_key) do update set speed=excluded.speed;
    update public.live_status set speed=88 where vehicle_key='kept';delete from public.live_status;`);
  check("(select count(*)=1 and bool_and(vehicle_key='kept' and speed=12) from public.live_status)",'enabled legacy live INSERT/UPSERT/UPDATE/DELETE skipped');
  equal(sync(snapshot),beforeInstall,'legacy live writes leave associations unchanged');
  sync(service+`insert into public.vehicles(key,plate,model,geotab_id,geotab_name) values('kept','SYNTHETIC','UPSERT metadata','stale','Stale')
    on conflict(key) do update set model=excluded.model,geotab_id=excluded.geotab_id,geotab_name=excluded.geotab_name;
    update public.vehicles set brand='UPDATED',geotab_id=null,geotab_name=null where key='kept';`);
  check("(select model='UPSERT metadata' and brand='UPDATED' and geotab_auto_link_disabled from public.vehicles where key='kept')",'vehicle business UPSERT/update and manual flag preserved');
  equal(sync(snapshot),beforeInstall,'UPDATE phase restores OLD mapping after INSERT ON CONFLICT');
  sync(service+"delete from public.vehicles where key='kept';");
  check("exists(select 1 from public.vehicles where key='kept') and exists(select 1 from public.desktop_vehicle_live where vehicle_key='kept')",'legacy vehicle DELETE cannot cascade desktop snapshot');
  equal(sync(snapshot),beforeInstall,'legacy vehicle DELETE preserves mapping snapshot');

  const legacyRpc=JSON.parse(sync(service+'select public.guard_test_legacy_rpc();'));
  equal(legacyRpc.current_user,'supabase_admin','legacy SECURITY DEFINER uses owner');
  equal(legacyRpc.jwt_role,'service_role','legacy SECURITY DEFINER retains actual JWT role');
  check("(select model='RPC metadata' from public.vehicles where key='kept') and (select speed=12 from public.live_status where vehicle_key='kept')",'legacy definer metadata allowed but live blocked');
  check("(select km=7 from public.guard_test_history where id='legacy-history') and (select state='done' from public.guard_test_jobs where id='legacy-job')",'legacy history and other jobs remain writable');
  equal(sync(snapshot),beforeInstall,'legacy definer preserves association snapshot');

  sync(service+"insert into public.vehicles(key,model,geotab_id,geotab_name) values('new','New metadata','legacy-new','Legacy new');");
  check("(select model='New metadata' and geotab_id is null and geotab_name is null from public.vehicles where key='new')",'new legacy vehicle retained without forced association');
  const afterNew=sync(snapshot);
  const claim=JSON.parse(sync(authenticated+`select public.desktop_worker_register(${q(device)},'Synthetic delegation test PC',true);select public.desktop_worker_claim(${q(device)});`).split('\n').at(-1));
  equal(claim.lease.fence,1,'real desktop lease acquired');
  sync(authenticated+worker('live_status','POST',{}, {vehicle_key:'desktop-live',speed:31}));
  sync(authenticated+worker('vehicles','PATCH',{key:'eq.new',geotab_id:'is.null',geotab_auto_link_disabled:'eq.false'},{geotab_id:'desktop-new',geotab_name:'Desktop new'}));
  check("(select speed=31 from public.live_status where vehicle_key='desktop-live') and (select geotab_id='desktop-new' and geotab_name='Desktop new' from public.vehicles where key='new')",'authenticated real SECURITY DEFINER desktop RPC passes active guards');
  assert.notEqual(sync(snapshot),afterNew,'only authorised desktop association changes snapshot');checks++;
  const afterDesktop=sync(snapshot);
  sync(authenticated+worker('live_status','DELETE',{vehicle_key:'eq.desktop-live'}));
  check("not exists(select 1 from public.live_status where vehicle_key='desktop-live')",'authenticated desktop live delete remains allowed');
  equal(sync(snapshot),afterDesktop,'desktop live delete leaves associations unchanged');
  reject(authenticated+worker('live_status','POST',{}, {vehicle_key:'stale',speed:1},0),/Desktop lease lost/);
  reject(service+worker('live_status','POST',{}, {vehicle_key:'spoofed',speed:1}),/permission denied for function desktop_worker_request/);
  check("not exists(select 1 from public.live_status where vehicle_key in ('stale','spoofed'))",'fencing and caller permissions stay enforced');

  // All three supported PostgREST claim encodings must retain service identity.
  for(const claimSetting of ['request.jwt.claim.role','request.jwt.claim','request.jwt.claims']){
    const value=claimSetting.endsWith('.role')?'service_role':'{"role":"service_role"}';
    sync(`set role service_role;set ${claimSetting}=${q(value)};update public.live_status set speed=87 where vehicle_key='kept';`);
    check("(select speed=12 from public.live_status where vehicle_key='kept')",claimSetting+' respected');
  }
  sync("set role service_role;set request.jwt.claim.role='service_role';set request.jwt.claims='{\"role\":\"authenticated\"}';update public.live_status set speed=87 where vehicle_key='kept';");
  check("(select speed=12 from public.live_status where vehicle_key='kept')",'explicit claim.role takes precedence');
  // Administrative SQL without a JWT intentionally remains outside the guard.
  sync("update public.live_status set speed=13 where vehicle_key='kept';");
  check("(select speed=13 from public.live_status where vehicle_key='kept')",'no-JWT owner maintenance remains possible');
  equal(sync(snapshot),afterDesktop,'identity tests preserve associations');

  reject(withFailure(restore),/division by zero/);
  check("(select bool_and(tgenabled='O') from pg_trigger where tgname in ('ludy_desktop_geotab_vehicle_guard','ludy_desktop_geotab_live_guard'))",'rollback error retains active guards');
  sync(restore);
  sync(service+"update public.live_status set speed=14 where vehicle_key='kept';update public.vehicles set geotab_name='Legacy after rollback' where key='new';");
  check("(select speed=14 from public.live_status where vehicle_key='kept') and (select geotab_name='Legacy after rollback' from public.vehicles where key='new')",'explicit disable restores legacy owner');
  sync(service+"delete from public.vehicles where key='kept';");
  check("not exists(select 1 from public.vehicles where key='kept') and not exists(select 1 from public.desktop_vehicle_live where vehicle_key='kept')",'explicit disable restores legacy deletion/cascade');

  // DDL activation waits for an earlier legacy transaction to drain. A client
  // request that runs after COMMIT sees the enabled guard without a cache gap.
  const writing=asyncSql("set application_name='geotab_guard_old_writer';begin;"+service+"update public.live_status set speed=15 where vehicle_key='kept';select pg_sleep(1.2);commit;");
  let inside=false;
  for(let n=0;n<50;n++){
    inside=sync("select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='geotab_guard_old_writer' and wait_event='PgSleep');")==='t';
    if(inside)break;await pause(20);
  }
  assert.ok(inside,'legacy transaction holds write lock');checks++;
  const activating=asyncSql("set application_name='geotab_guard_activation';"+activate);
  await pause(80);
  check("exists(select 1 from pg_stat_activity where datname=current_database() and application_name='geotab_guard_activation' and wait_event_type='Lock')",'activation waits for preexisting writer transaction');
  const [written,activated]=await Promise.all([writing,activating]);
  equal(written.code,0,'in-flight old writer completes before cutover');equal(activated.code,0,'activation completes after writer commit');
  sync(service+"update public.live_status set speed=16 where vehicle_key='kept';");
  check("(select speed=15 from public.live_status where vehicle_key='kept')",'later legacy write blocked immediately after activation');
  console.log(JSON.stringify({ok:true,checks,postgresMajor:17,isolatedDatabase:true,migrationSha256:createHash('sha256').update(migration).digest('hex'),realDesktopLeaseRpc:true,definerCallerIdentityVerified:true,activationWaitedForPriorWriter:true}));
}finally{if(created)sync(`drop database "${database}" with(force);`,'postgres');}
