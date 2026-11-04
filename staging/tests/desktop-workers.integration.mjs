import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';

// Every DDL change and fixture is rolled back on the guarded local database.
// No environment variable can select a remote Docker daemon or PostgreSQL host.
assertLocalProject();
if(process.argv.length!==2)throw Error('This test accepts no connection or target options.');
const migration=readFileSync(new URL('../production/desktop-workers.sql',import.meta.url),'utf8');
const uid=randomUUID(),other=randomUUID(),manager=randomUUID(),viewer=randomUUID(),device=randomUUID(),standby=randomUUID(),foreign=randomUUID();
const vehicle='WORKER-TEST-'+randomUUID(),label='Synthetic collector',name="Synthetic worker driver's name",driver=randomUUID();
const q=v=>"'"+String(v).replaceAll("'","''")+"'",j=v=>q(JSON.stringify(v))+'::jsonb';
const owner="reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';";
const auth=id=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(id)};set local request.jwt.claims=${q(JSON.stringify({sub:id,role:'authenticated',session_id:randomUUID()}))};`;
const register=(id=device,enabled=true)=>`public.desktop_worker_register(${q(id)},${q(label)},${enabled})`;
const state=id=>`public.desktop_worker_status(${q(id)})`;
const fence="current_setting('worker_test.fence')::bigint";
const claim=id=>`public.desktop_worker_claim(${q(id)})`;
const request=(resource,method='GET',{id=device,generation=fence,params={},body=null,prefer=null}={})=>`public.desktop_worker_request(${q(id)},${generation},${q(resource)},${q(method)},${j(params)},${body===null?'null':j(body)},${prefer===null?'null':q(prefer)})`;
let checks=0;
const check=(value,label)=>{checks++;return `do $test$ begin if (${value}) is distinct from true then raise exception 'worker-test: ${label}';end if;end $test$;`;};
const reject=(sql,label,code='22023')=>{checks++;return `do $test$ declare denied boolean:=false;begin begin ${sql};exception when sqlstate '${code}' then denied:=true;end;if not denied then raise exception 'worker-test: ${label}';end if;end $test$;`;};
const perform=call=>`do $test$ begin perform ${call};end $test$;`;
const remember=id=>`do $test$ begin perform set_config('worker_test.fence',(${claim(id)}->'lease'->>'fence'),true);end $test$;`;
const noWrite=(resource,method,body,label,params={id:'eq.1'})=>reject('perform '+request(resource,method,{params,body}),label);
const sql=[
 "begin;set local statement_timeout='20s';set local lock_timeout='2s';",LOCAL_GUARD,
 check("to_regclass('public.desktop_worker_devices') is null",'ownership_schema_not_installed_durably'),migration,
 ...[uid,other,manager,viewer].map((id,i)=>`insert into auth.users(id,email,aud,role) values(${q(id)},${q(id+'@example.invalid')},'authenticated','authenticated');update public.profiles set role=${q(i<2?'admin':i===2?'manager':'viewer')} where user_id=${q(id)};`),
 `insert into public.vehicles(key,plate,geotab_id,active) values(${q(vehicle)},'SYNTHETICWORKER','worker-device','OUI');`,
 `insert into public.fleet_drivers(id,name) values(${q(driver)},'Synthetic worker profile');`,
 // A trigger checks the original caller claims inside the privileged transaction.
 `create function desktop_worker_private.test_claims() returns trigger language plpgsql set search_path='' as $$begin if new.vehicle_key=${q(vehicle)} and (auth.uid() is distinct from ${q(uid)}::uuid or auth.role() is distinct from 'authenticated') then raise exception 'worker-test: original_user_claims_lost';end if;return new;end$$;`,
 `create trigger desktop_worker_test_claims before insert or update on public.ops_fuel_checkpoints for each row execute function desktop_worker_private.test_claims();`,
 auth(manager),reject('perform '+register(),'manager_cannot_register','42501'),
 auth(viewer),reject('perform '+register(),'viewer_cannot_register','42501'),
 auth(randomUUID()),reject('perform '+register(),'profile_missing_cannot_register','42501'),
 owner,'set local role anon;',reject('perform '+register(),'anonymous_cannot_register','42501'),
 owner,'set local role service_role;',reject('perform '+register(),'service_role_cannot_impersonate_user','42501'),
 auth(uid),reject('perform '+request('fleet_sources','GET',{generation:'null'}),'unregistered_device_cannot_read','42501'),
 check(`(${register(device,false)}->'device'->>'enabled')::boolean=false`,'register_requires_explicit_enable'),
 reject('perform '+claim(device),'disabled_device_cannot_claim','42501'),
 check(`(${request('uber_report_settings','GET',{generation:'null',params:{id:'eq.1',select:'id,enabled,revision'}})}->>'status')::int=200`,'registered_disabled_admin_can_read_report_metadata'),
 reject(`perform public.desktop_worker_request(${q(device)},null,'fleet_sources','PATCH','{"id":"eq.uber"}'::jsonb,'{"status":"paused"}'::jsonb,null)`,'disabled_device_cannot_write','42501'),
 check(`(${register()}->'device'->>'enabled')::boolean`,'explicit_admin_enable'),
 check(`(${claim(device)}->'lease'->>'owned')::boolean`,'first_claim_owned'),remember(device),
 check(`(${claim(device)}->'lease'->>'fence')::bigint=${fence}`,'claim_same_active_owner_preserves_fence'),
 check(`((${state(device)}->'lease'->>'expires_at')::timestamptz-clock_timestamp()) between interval '85 seconds' and interval '90 seconds'`,'lease_uses_database_time_90_seconds'),
 reject('select * from public.desktop_worker_leases','no_direct_lease_read','42501'),
 reject(`update public.desktop_worker_devices set enabled=true where id=${q(device)}`,'no_direct_device_write','42501'),
 reject(`perform desktop_worker_private.rpc('rpc/fleet_reconcile_vehicle_contracts','{}'::jsonb)`,'private_rpc_not_callable','42501'),
 perform(register(standby)),check(`not (${claim(standby)}->'lease'->>'owned')::boolean`,'other_device_waits_without_error'),
 auth(other),reject('perform '+register(),'another_admin_cannot_adopt_device_id','42501'),
 reject('perform '+state(device),'another_admin_cannot_read_device_state','42501'),
 perform(register(foreign)),check(`not (${claim(foreign)}->'lease'->>'owned')::boolean`,'another_admin_collects_only_after_lease_available'),
 auth(uid),
 check(`(${request('fleet_sources','GET',{generation:'null',params:{select:'id,status',id:'in.(uber,bolt)',order:'id',limit:'1',offset:'1'},prefer:'count=exact'})}->'headers'->>'content-range')='1-1/2'`,'read_pagination_and_exact_count'),
 check(`jsonb_array_length(${request('fleet_sources','GET',{generation:'null',params:{id:"eq.uber' OR true --"}})}->'body')=0`,'filter_values_are_literals'),
 check(`jsonb_array_length(${request('fleet_sources','GET',{generation:'null',params:{id:'in.("uber","bolt")'}})}->'body')=2`,'quoted_in_filters_used_by_parking'),
 reject('perform '+request('fleet_sources','GET',{params:{id:'in.("uber",5)'}}),'quoted_in_list_rejects_non_strings'),
 check(`not exists(select 1 from jsonb_array_elements(${request('params','GET',{generation:'null'})}->'body') r where r->>'key' not in ('environment','shiftDay','shiftNight','shiftAdvance','tzRules'))`,'params_only_scheduling_and_environment'),
 ...['auth.users','profiles','jobs','geotab_session','user_sessions','desktop_worker_leases','provider_earnings_snapshots','fleet_sources;select pg_sleep(10)'].map(resource=>reject('perform '+request(resource),'deny_resource_'+resource.replace(/[^a-z]/g,'_'))),
 reject('perform '+request('agencies','GET',{params:{select:'id,rh_drive'}}),'no_hr_drive_metadata'),
 reject('perform '+request('drivers','GET',{params:{select:'code,email'}}),'no_unneeded_personal_fields'),
 reject('perform '+request('fleet_sources','GET',{params:{select:'id,(select version())'}}),'selection_not_sql'),
 reject('perform '+request('fleet_sources','GET',{params:{order:'id;select pg_sleep(10)'}}),'order_not_sql'),
 reject('perform '+request('fleet_sources','GET',{params:{or:'(id.eq.uber,id.eq.bolt)'}}),'unknown_query_operators_denied'),
 reject('perform '+request('fleet_sources','GET',{params:{limit:'1001'}}),'bounded_pages'),
 reject('perform '+request('fleet_sources','GET',{params:{offset:'100001'}}),'bounded_offset'),
 reject('perform '+request('fleet_sources','GET',{params:{id:['eq.uber',7]}}),'repeated_filters_are_strings'),
 reject('perform '+request('fleet_sources','GET',{body:{secret:'unsupported'}}),'read_body_denied'),
 check(`jsonb_array_length(${request('fleet_sources','GET',{params:{id:['neq.geotab','neq.myclicar'],and:'(id.neq.uber)',select:'id'}})}->'body')=1`,'repeated_filters_and_and_bounds'),
 // Fenced inserts preserve database defaults and quoted values.
 check(`(${request('fleet_drivers','POST',{body:{name},prefer:'return=representation'})}->'body'->0->>'name')=${q(name)}`,'insert_defaults_and_quoted_values'),
 check(`(${request('fleet_drivers','POST',{params:{select:'name'},body:{name},prefer:'return=representation'})}->'body'->0)=${j({name})}`,'write_response_respects_frozen_selection'),
 noWrite('fleet_drivers','POST',{name:'Synthetic',agency_id:123},'cannot_forge_driver_agency',{}),
 noWrite('fleet_settings','PATCH',{enabled:false},'collector_cannot_change_rules'),
 noWrite('uber_report_settings','PATCH',{organization_id:randomUUID()},'collector_cannot_change_report_organization'),
 noWrite('uber_report_settings','PATCH',{csv_timezone:'UTC'},'collector_cannot_change_timezone'),
 noWrite('vehicles','PATCH',{agency_id:123},'collector_cannot_change_vehicle_agency',{key:'eq.'+vehicle}),
 reject('perform '+request('fleet_sources','PATCH',{body:{status:'paused'}}),'unbounded_patch_denied'),
 reject('perform '+request('fleet_sources','DELETE',{params:{id:'eq.uber'}}),'source_deletion_denied'),
 reject('perform '+request('fleet_drivers','PATCH',{params:{id:'eq.'+driver,auto_link_disabled:'eq.false'},body:{vehicle_key:null,vehicle_link_evidence:{}}}),'null_auto_method_not_accepted'),
 reject('perform '+request('fleet_drivers','PATCH',{params:{id:'eq.'+driver},body:{vehicle_link_evidence:{}}}),'evidence_requires_optimistic_revision'),
 check(`(${request('ops_fuel_checkpoints','POST',{params:{on_conflict:'vehicle_key'},body:{vehicle_key:vehicle,state:{value:1},updated_at:'2026-11-01T00:00:00Z'},prefer:'resolution=merge-duplicates,return=representation'})}->'body'->0->'state'->>'value')='1'`,'upsert_typed_record_and_original_claims'),
 check(`(${request('ops_fuel_checkpoints','POST',{params:{on_conflict:'vehicle_key'},body:{vehicle_key:vehicle,state:{value:2},updated_at:'2026-11-01T00:01:00Z'},prefer:'resolution=merge-duplicates,return=representation'})}->'body'->0->'state'->>'value')='2'`,'conflict_updates_only_named_columns'),
 check(`jsonb_array_length(${request('ops_fuel_checkpoints','POST',{params:{on_conflict:'vehicle_key'},body:{vehicle_key:vehicle,state:{value:3},updated_at:'2026-11-01T00:02:00Z'},prefer:'resolution=ignore-duplicates,return=representation'})}->'body')=0`,'ignore_duplicates_keeps_existing'),
 reject('perform '+request('ops_fuel_checkpoints','POST',{params:{on_conflict:'state'},body:{vehicle_key:vehicle,state:{value:3}},prefer:'resolution=merge-duplicates'}),'conflict_key_allowlist'),
 reject('perform '+request('ops_fuel_checkpoints','POST',{params:{on_conflict:'vehicle_key'},body:{state:{}},prefer:'resolution=merge-duplicates'}),'conflict_key_required_in_body'),
 check(`(${request('ops_fuel_checkpoints','DELETE',{params:{vehicle_key:'eq.'+vehicle}})}->>'status')::int=204`,'bounded_checkpoint_delete'),
 check(`jsonb_array_length(${request('ops_fuel_checkpoints','GET',{params:{vehicle_key:'eq.'+vehicle}})}->'body')=0`,'bounded_delete_effect'),
 reject('perform '+request('rpc/uber_report_configure','POST',{body:{}}),'administrative_rpc_denied'),
 reject('perform '+request('rpc/provider_earnings_commit','POST',{body:{p_snapshot:{},p_extra:true}}),'rpc_extra_arguments_denied'),
 reject('perform '+request('rpc/ops_set_measured_fuel_reference','POST',{body:{p_vehicle:vehicle,p_device:'worker-device'}}),'rpc_missing_arguments_denied'),
 reject('perform '+request('rpc/fleet_auto_link_vehicle','POST',{body:{p_driver:'not-a-uuid',p_vehicle_key:vehicle,p_evidence:{}}}),'rpc_uuid_typed_cast','22P02'),
 // The real business RPC validates evidence and returns a boolean; no fake RPC.
 check(`(${request('rpc/ops_set_measured_fuel_reference','POST',{body:{p_vehicle:vehicle,p_device:'worker-device',p_reference:{value:5,method:'geotab_history',from:'2026-10-19T00:00:00Z',to:'2026-10-26T00:00:00Z',distance_km:100,fuel_l:5,counter_at:{km:{from:'2026-10-19T00:00:00Z',to:'2026-10-26T00:00:00Z'},fuel_l:{from:'2026-10-19T00:00:00Z',to:'2026-10-26T00:00:00Z'}}}}})}->'body')='true'::jsonb`,'typed_business_rpc_roundtrip'),
 owner,check(`(select ref_l100=5 from public.vehicles where key=${q(vehicle)})`,'business_rpc_changed_only_synthetic_vehicle'),
 // This existing guard remains unchanged; the dispatcher never writes staging.
 `update public.params set value='production-worker-test' where key='environment';`,auth(uid),
 reject('perform '+request('rpc/ops_set_measured_fuel_reference','POST',{body:{p_vehicle:vehicle,p_device:'worker-device',p_reference:{}}}),'existing_environment_guard_preserved','P0001'),
 owner,check(`(select value='production-worker-test' from public.params where key='environment')`,'environment_never_forged'),`update public.params set value='staging' where key='environment';`,auth(uid),
 check(`(public.desktop_worker_renew(${q(device)},${fence})->'lease'->>'fence')::bigint=${fence}`,'renew_same_fence'),
 reject(`perform public.desktop_worker_renew(${q(device)},${fence}+1)`,'wrong_fence_renew_denied','55000'),
 reject('perform '+request('fleet_drivers','POST',{generation:fence+'+1',body:{name:'Synthetic refused'}}),'wrong_fence_write_denied','55000'),
 owner,`update public.desktop_worker_leases set expires_at=clock_timestamp()-interval '1 second' where scope='workspace';`,auth(uid),
 reject(`perform public.desktop_worker_renew(${q(device)},${fence})`,'expired_owner_cannot_renew','55000'),
 reject('perform '+request('fleet_drivers','POST',{body:{name:'Synthetic refused'}}),'expired_owner_cannot_write','55000'),
 check(`(${claim(standby)}->'lease'->>'fence')::bigint=${fence}+1`,'takeover_increments_fence'),
 reject(`perform public.desktop_worker_release(${q(device)},${fence})`,'old_owner_cannot_release_new_owner','55000'),
 reject('perform '+request('fleet_drivers','POST',{body:{name:'Synthetic refused'}}),'stale_owner_cannot_write_after_takeover','55000'),
 perform(`public.desktop_worker_release(${q(standby)},${fence}+1)`),remember(device),
 perform(register(device,false)),check(`not (${state(device)}->'lease'->>'owned')::boolean`,'disable_releases_ownership'),
 perform(register()),reject(`perform public.desktop_worker_renew(${q(device)},${fence})`,'reenable_requires_new_claim','55000'),
 check(`(${claim(device)}->'lease'->>'fence')::bigint=${fence}+1`,'reenable_new_generation'),remember(device),
 // A row operation deliberately outlasts the lease; its insert must roll back.
 owner,
 `create function desktop_worker_private.test_slow() returns trigger language plpgsql set search_path='' as $$begin if new.vehicle_key=${q(vehicle)} then perform pg_sleep(0.06);end if;return new;end$$;`,
 `create trigger desktop_worker_test_slow before insert on public.ops_fuel_checkpoints for each row execute function desktop_worker_private.test_slow();`,
 `update public.desktop_worker_leases set expires_at=clock_timestamp()+interval '30 milliseconds' where scope='workspace';`,auth(uid),
 reject('perform '+request('ops_fuel_checkpoints','POST',{body:{vehicle_key:vehicle,state:{},updated_at:'2026-11-01T00:00:00Z'}}),'expiry_during_write_rolls_back','55000'),
 owner,check(`not exists(select 1 from public.ops_fuel_checkpoints where vehicle_key=${q(vehicle)})`,'expired_transaction_insert_not_persisted'),
 `update public.profiles set role='viewer' where user_id=${q(uid)};`,auth(uid),
 reject('perform '+request('uber_report_settings','GET',{generation:'null'}),'role_revoked_blocks_metadata','42501'),
 reject('perform '+claim(device),'role_revoked_blocks_ownership','42501'),
 owner,
 check(`(select relrowsecurity from pg_class where oid='public.desktop_worker_devices'::regclass)`,'device_rls_enabled'),
 check(`not has_table_privilege('authenticated','public.desktop_worker_devices','INSERT,UPDATE,DELETE')`,'device_direct_write_privileges_absent'),
 check(`not has_function_privilege('anon','public.desktop_worker_request(uuid,bigint,text,text,jsonb,jsonb,text)','EXECUTE')`,'anonymous_rpc_grant_absent'),
 check(`not has_schema_privilege('authenticated','desktop_worker_private','USAGE')`,'private_helpers_not_exposed'),
 check(`(select value='staging' from public.params where key='environment')`,'environment_preserved_at_end'),
 'rollback;'
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
function run(input){return spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(v=>v==='--username=postgres'?'--username=supabase_admin':v),{input,encoding:'utf8',timeout:45000,maxBuffer:1048576,env});}
const result=run(sql);
if(result.error||result.status!==0){const dir=new URL('../.local/checks/',import.meta.url);mkdirSync(dir,{recursive:true,mode:0o700});const file=new URL('desktop-workers-private-error.log',dir);writeFileSync(file,String(result.stderr),{mode:0o600});chmodSync(file,0o600);throw Error('Local desktop worker rollback failed: '+(String(result.stderr).match(/worker-test: ([a-z_0-9]+)/)?.[1]||'SQL validation; diagnostic is private'));}
assert.equal(result.stdout.trim(),'');
const after=run(`begin read only;${LOCAL_GUARD}select to_regclass('public.desktop_worker_devices') is null and not exists(select 1 from auth.users where id=${q(uid)}) and not exists(select 1 from public.vehicles where key=${q(vehicle)});rollback;`);
assert.equal(after.status,0);assert.equal(after.stdout.trim(),'t');
console.log(JSON.stringify({ok:true,checks,rolledBack:true,ownershipInstalled:false,target:'local-staging-only'}));
