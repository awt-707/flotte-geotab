import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {randomUUID,randomInt,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
assertLocalProject();if(process.argv.length!==2)throw Error('No target options accepted.');
const admin=randomUUID(),other=randomUUID(),manager=randomUUID(),device=randomUUID(),foreign=randomUUID(),zone=randomUUID(),event=randomUUID(),report=randomUUID();
const agency=Date.now()*1000+randomInt(500),code='DESKTOP-ADMIN-'+randomUUID(),vehicle='DESKTOP-ADMIN-'+randomUUID();
const hash=createHash('sha256').update(randomUUID()).digest('hex'),name='Synthetic Desktop Driver';
const q=v=>"'"+String(v).replaceAll("'","''")+"'",j=v=>q(JSON.stringify(v))+'::jsonb';
const owner="reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';";
const auth=id=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(id)};set local request.jwt.claims=${q(JSON.stringify({sub:id,role:'authenticated'}))};`;
const call=(resource,method='GET',{id=device,params={},body=null,prefer=null}={})=>`public.desktop_admin_request(${q(id)},${q(resource)},${q(method)},${j(params)},${body===null?'null':j(body)},${prefer===null?'null':q(prefer)})`;
const rpc=(name,body)=>call('rpc/'+name,'POST',{body});
let checks=0;const check=(condition,label)=>{checks++;return `do $$begin if (${condition}) is distinct from true then raise exception 'desktop-admin-test: ${label}';end if;end$$;`;};
const reject=(sql,label,state='22023')=>{checks++;return `do $$declare denied boolean:=false;begin begin ${sql};exception when sqlstate '${state}' then denied:=true;end;if not denied then raise exception 'desktop-admin-test: ${label}';end if;end$$;`;};
const perform=sql=>`do $$begin perform ${sql};end$$;`;
const account="current_setting('desktop_admin_test.account')::uuid";
const configure={p_enabled:false,p_org:null,p_mapping:{},p_format:'ymd',p_user:admin,p_org_label:null,p_csv_timezone:'Africa/Casablanca'};
const zoneRow={id:zone,name:'Synthetic parking',kind:'parking',agency_id:agency,shape:{type:'circle',lat:33.5,lon:-7.6,radius:100},enabled:true,indicative:true,fingerprint:hash,updated_at:'2026-11-04T00:00:00Z',source:'manual',source_id:null};
const patchZone={name:'Synthetic parking revised',kind:'parking',agency_id:agency,shape:zoneRow.shape,enabled:true,indicative:true,fingerprint:hash,updated_at:'2026-11-04T00:01:00Z'};
const rpcEvent={p_action:'create',p_id:event,p_expected:null,p_row:{title:'Synthetic event',place:'Synthetic place',city:'Casablanca',fingerprint:hash,starts_at:'2026-11-05T12:00:00Z',ends_at:'2026-11-05T13:00:00Z'},p_user:admin};
const provisioning={ludy_driver_code:code,agency_id:agency,display_name:name,credential_hash:hash,active:true,created_at:'2026-11-04T00:00:00Z',rotated_at:'2026-11-04T00:00:00Z'};
const sql=['begin;',"set local statement_timeout='20s';set local lock_timeout='2s';",LOCAL_GUARD,
 readFileSync(new URL('../production/desktop-workers.sql',import.meta.url),'utf8'),readFileSync(new URL('../production/desktop-admin.sql',import.meta.url),'utf8'),
 ...[admin,other,manager].map((id,i)=>`insert into auth.users(id,email,aud,role) values(${q(id)},${q(id+'@example.invalid')},'authenticated','authenticated');update public.profiles set role=${q(i<2?'admin':'manager')} where user_id=${q(id)};`),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic desktop agency','Casablanca');insert into public.drivers(code,name,agency_id) values(${q(code)},${q(name)},${agency});insert into public.vehicles(key,plate,agency_id) values(${q(vehicle)},'SYNTHETIC',${agency});`,
 auth(admin),perform(`public.desktop_worker_register(${q(device)},'Synthetic admin PC',false)`),
 check(`not (public.desktop_worker_status(${q(device)})->'lease'->>'owned')::boolean`,'admin_actions_without_collector_lease'),
 check(`(${call('fleet_settings','PATCH',{params:{id:'eq.1'},body:{offline_threshold_s:123},prefer:'return=representation'})}->'body'->0->>'offline_threshold_s')='123'`,'settings_updated_without_lease'),
 check(`(${call('fleet_settings','PATCH',{params:{id:'eq.1'},body:{disconnection_enabled:true,disconnection_policy:'all',duty_mode:'shift'}})}->>'status')='204'`,'disconnection_settings'),
 check(`(${call('ops_fuel_settings','PATCH',{params:{id:'eq.1'},body:{enabled:true,excess_pct:25,min_distance_km:10,cooldown_minutes:30}})}->>'status')='204'`,'fuel_settings'),
 check(`(${call('vehicles','PATCH',{params:{key:'eq.'+vehicle},body:{ref_l100:5,fuel_reference_evidence:{method:'manual',value:5,calculated_at:'2026-11-04T00:00:00Z'}},prefer:'return=representation'})}->'body'->0->>'ref_l100')='5'`,'manual_fuel_reference'),
 reject('perform '+call('vehicles','PATCH',{params:{key:'eq.'+vehicle},body:{agency_id:agency+1}}),'cannot_change_vehicle_agency'),
 reject('perform '+call('vehicles','PATCH',{params:{key:'eq.'+vehicle},body:{ref_l100:5,fuel_reference_evidence:{method:'geotab_history',value:5}}}),'cannot_forge_measured_fuel_reference'),
 reject('perform '+call('vehicles','PATCH',{params:{key:'eq.'+vehicle},body:{geotab_auto_link_disabled:true}}),'provider_association_disabled_device_refused','42501'),
 perform(`public.desktop_worker_register(${q(device)},'Synthetic admin PC',true)`),
 reject('perform '+call('vehicles','PATCH',{params:{key:'eq.'+vehicle},body:{geotab_auto_link_disabled:true}}),'provider_association_requires_active_owner','55000'),
 perform(`public.desktop_worker_claim(${q(device)})`),
 check(`(${call('vehicles','PATCH',{params:{key:'eq.'+vehicle},body:{geotab_id:'synthetic-device',geotab_name:'Synthetic tracker',geotab_auto_link_disabled:true},prefer:'return=representation'})}->'body'->0->>'geotab_id')='synthetic-device'`,'manual_provider_association_with_active_ownership'),
 reject('perform '+call('vehicles','PATCH',{params:{key:'eq.'+vehicle},body:{geotab_auto_link_disabled:true,ref_l100:6}}),'provider_association_not_mixed_with_fuel'),
 perform(`public.desktop_worker_release(${q(device)},(public.desktop_worker_status(${q(device)})->'lease'->>'fence')::bigint)`),
 reject('perform '+call('fleet_settings','PATCH',{body:{enabled:false}}),'unbounded_settings_refused'),
 check(`(${rpc('uber_report_configure',configure)}->'body'->>'csv_timezone')='Africa/Casablanca'`,'real_report_config_rpc'),
 reject('perform '+rpc('uber_report_configure',{...configure,p_user:other}),'forged_rpc_actor_refused','42501'),
 reject('perform '+rpc('uber_report_configure',{...configure,p_user:null}),'null_rpc_actor_refused','42501'),
 reject('perform '+rpc('uber_report_configure',{...configure,p_extra:true}),'rpc_extra_argument_refused'),
 check(`(${call('fleet_parking_zones','POST',{params:{on_conflict:'id'},body:zoneRow,prefer:'resolution=ignore-duplicates,return=representation'})}->'body'->0->>'id')=${q(zone)}`,'manual_zone_creation'),
 check(`jsonb_array_length(${call('fleet_parking_zones','POST',{params:{on_conflict:'id'},body:zoneRow,prefer:'resolution=ignore-duplicates,return=representation'})}->'body')=0`,'manual_zone_creation_idempotent'),
 reject('perform '+call('fleet_parking_zones','PATCH',{params:{id:'eq.'+zone},body:patchZone}),'parking_revision_required'),
 check(`(${call('fleet_parking_zones','PATCH',{params:{id:'eq.'+zone,revision:'eq.1',archived_at:'is.null'},body:patchZone,prefer:'return=representation'})}->'body'->0->>'revision')='2'`,'parking_revision_advances'),
 check(`jsonb_array_length(${call('fleet_parking_zones','PATCH',{params:{id:'eq.'+zone,revision:'eq.1',archived_at:'is.null'},body:patchZone,prefer:'return=representation'})}->'body')=0`,'stale_parking_update_no_effect'),
 check(`(${rpc('fleet_archive_parking_zone',{p_id:zone,p_revision:2,p_user:admin})}->'body'->>'outcome')='archived'`,'parking_archives_through_business_rpc'),
 check(`(${rpc('ops_mutate_manual_event',rpcEvent)}->'body'->>'ok')::boolean`,'manual_event_with_actor'),
 check(`(${rpc('ops_mutate_manual_event',{...rpcEvent,p_action:'delete',p_expected:hash,p_row:null})}->'body'->>'ok')::boolean`,'manual_event_delete_uses_revision'),
 check(`(${call('ops_rush_rules','POST',{body:{agency_id:agency,city:'Casablanca',days:[1],start:'08:00',end:'09:00',enabled:true,label:'Synthetic'},prefer:'return=representation'})}->'body'->0->>'agency_id')=${q(agency)}`,'admin_rush_rule'),
 reject('perform '+call('ops_rush_rules','POST',{body:{agency_id:agency,city:'Marrakech',days:[1],start:'08:00',end:'09:00',enabled:true,label:'Synthetic'}}),'rush_rule_agency_city_conflict'),
 `do $$declare result jsonb;begin result:=${call('driver_portal_accounts','POST',{body:provisioning,prefer:'return=representation'})};if (result->'body'->0) ? 'credential_hash' then raise exception 'desktop-admin-test: account_creation_leaked_hash';end if;perform set_config('desktop_admin_test.account',result->'body'->0->>'id',true);end$$;`,
 check(`jsonb_array_length(${call('driver_portal_accounts','GET',{params:{ludy_driver_code:'eq.'+code,limit:'2000'}})}->'body')=1`,'account_admin_read_2000_limit'),
 check(`not (${call('driver_portal_accounts','GET',{params:{ludy_driver_code:'eq.'+code}})}->'body'->0 ? 'credential_hash')`,'account_hash_not_exposed'),
 reject('perform '+call('driver_portal_accounts','GET',{params:{select:'credential_hash'}}),'account_hash_selection_refused'),
 reject('perform '+call('driver_portal_accounts','GET',{params:{credential_hash:'eq.'+hash}}),'account_hash_filter_refused'),
 reject('perform '+call('driver_portal_accounts','POST',{body:{...provisioning,agency_id:agency+1}}),'account_reference_scope_required'),
 owner,`insert into public.driver_reports(id,account_id,category,city,place,description) values(${q(report)},${account},'incident','Casablanca','Synthetic place','Synthetic report only');`,auth(admin),
 check(`(${call('driver_reports','PATCH',{params:{id:'eq.'+report},body:{status:'verified',admin_note:'Synthetic moderation',reviewed_at:'2026-11-04T00:00:00Z',reviewed_by:admin},prefer:'return=representation'})}->'body'->0->>'reviewed_by')=${q(admin)}`,'report_moderator_uses_session_actor'),
 reject('perform '+call('driver_reports','PATCH',{params:{id:'eq.'+report},body:{status:'verified',admin_note:'',reviewed_at:'2026-11-04T00:00:00Z',reviewed_by:other}}),'forged_report_actor_refused','42501'),
 `do $$begin if (public.desktop_admin_request(${q(device)},'rpc/driver_portal_rotate','POST','{}',jsonb_build_object('p_account',${account},'p_credential_hash',null,'p_user',${q(admin)}),null)->'body'->>'active')::boolean is distinct from false then raise exception 'desktop-admin-test: account_revocation_failed';end if;end$$;`,
 ...['driver_portal_sessions','profiles','jobs','geotab_session'].map(resource=>reject('perform '+call(resource),'no_privileged_resource_'+resource)),
 ...['driver_portal_login','provider_earnings_commit','telemetry_archive_ingest','fleet_commit_parking'].map(name=>reject('perform '+rpc(name,{}),'not_collector_or_login_'+name)),
 reject('perform '+call('fleet_sources','PATCH',{params:{id:'eq.geotab'},body:{status:'paused'}}),'provider_pause_remains_fenced'),
 reject('perform '+call('driver_reports','DELETE',{params:{id:'eq.'+report}}),'generic_delete_not_available'),
 auth(other),perform(`public.desktop_worker_register(${q(foreign)},'Other admin PC',false)`),reject('perform '+call('fleet_settings','PATCH',{params:{id:'eq.1'},body:{enabled:false}}),'different_device_owner_refused','42501'),
 auth(manager),reject('perform '+call('fleet_settings','PATCH',{params:{id:'eq.1'},body:{enabled:false}}),'manager_never_elevated_to_admin','42501'),
 owner,`update public.profiles set role='viewer' where user_id=${q(admin)};`,auth(admin),reject('perform '+call('driver_portal_accounts'),'role_revocation_blocks_admin_reads','42501'),
 owner,check(`not has_function_privilege('anon','public.desktop_admin_request(uuid,text,text,jsonb,jsonb,text)','EXECUTE')`,'no_anonymous_admin_execute'),
 check(`not has_function_privilege('authenticated','desktop_worker_private.admin_columns(text)','EXECUTE')`,'private_admin_helper_not_exposed'),
 check(`(select value='staging' from public.params where key='environment')`,'no_environment_rewrite'),
 'rollback;'].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(v=>v==='--username=postgres'?'--username=supabase_admin':v),{input:sql,encoding:'utf8',timeout:45000,maxBuffer:1048576,env});
if(result.error||result.status!==0){const dir=new URL('../.local/checks/',import.meta.url);mkdirSync(dir,{recursive:true,mode:0o700});const file=new URL('desktop-admin-private-error.log',dir);writeFileSync(file,String(result.stderr),{mode:0o600});chmodSync(file,0o600);throw Error('Local desktop admin rollback failed: '+(String(result.stderr).match(/desktop-admin-test: ([a-z_0-9]+)/)?.[1]||'SQL validation; private diagnostic'));}
assert.equal(result.stdout.trim(),'');console.log(JSON.stringify({ok:true,checks,rolledBack:true,target:'local-staging-only',adminNoLease:true,driverLoginExcluded:true}));
