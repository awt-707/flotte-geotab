import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {randomUUID,randomInt} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {normalizeUberEarnings,parseUberEarningsPeriod} from '../server/uber-earnings.mjs';
assertLocalProject();
if(process.argv.slice(2).some(x=>x!=='--with-migration'))throw Error('Unsupported option');
const org=randomUUID(),foreign=randomUUID(),admin=randomUUID(),manager=randomUUID(),agency=Date.now()*1000+randomInt(100),suffix=randomUUID(),pids=[randomUUID(),null,randomUUID(),randomUUID()];
const codes=['A','B','C'].map(x=>'RECONCILE-'+suffix+'-'+x),fleet=randomUUID(),conflictFleet=randomUUID(),extraTarget=randomUUID(),vehicle='reconcile-'+suffix;
const now=Date.now(),parts=globalThis.LudyMoroccoTime.moroccoParts(now),day=String(parts.day).padStart(2,'0')+'/'+String(parts.month).padStart(2,'0')+'/'+parts.year;
const input={version:1,source:'uber_fleet_earnings',organizationId:org,sourceUrl:'https://fleethub.uber.com/orgs/'+org+'/earnings',observedAt:new Date(now).toISOString(),providerPeriod:parseUberEarningsPeriod(day+' 00:00 - '+day+' 23:59'),currency:'MAD',fleet:{revenue:'400 MAD'},drivers:pids.map((id,i)=>({providerDriverId:id,driverName:'Synthetic identity '+i,driverNameComplete:true,metrics:{revenue:'100 MAD'}})),coverage:{complete:true,filtered:false,driverRowsObserved:4,driverRowsTotal:4,pages:1}};
const normalized=normalizeUberEarnings(input,{organizationId:org,now}),q=v=>"'"+String(v).replaceAll("'","''")+"'",j=v=>q(JSON.stringify(v))+'::jsonb';
let checks=0;const check=(condition,label)=>{checks++;return `do $$ begin if (${condition}) is distinct from true then raise exception 'reconciliation-test: ${label}';end if;end $$;`;};
const reject=(statement,label)=>{checks++;return `do $$ declare refused boolean:=false;begin begin ${statement};exception when others then refused:=true;end;if not refused then raise exception 'reconciliation-test: ${label}';end if;end $$;`;};
const owner="reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';";
const auth=id=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(id)};set local request.jwt.claims=${q(JSON.stringify({sub:id,role:'authenticated'}))};`;
const snapshot=`(select id from public.provider_earnings_snapshots where organization_id=${q(org)})`;
function call({row=0,code=codes[0],scope=agency,revision=1,proof='Synthetic provider profile reviewed 2026-11-03',confirmed=true,assign=false}={}){return `public.provider_earnings_reconcile(${snapshot},${revision},${row},${q(code)},${scope},'provider_profile',${q(proof)},${confirmed},${assign})`;}
const sql=['begin;',"set local statement_timeout='20s';set local lock_timeout='2s';",LOCAL_GUARD,
 ...(process.argv.includes('--with-migration')?[readFileSync(new URL('../supabase/migrations/20261231000000_provider_earnings_reconciliation.sql',import.meta.url),'utf8')]:[]),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic reconciliation A','Casablanca'),(${agency+1},'Synthetic reconciliation B','Marrakech');`,
 `insert into auth.users(id,email,aud,role) values(${q(admin)},${q(suffix+'-a@example.invalid')},'authenticated','authenticated'),(${q(manager)},${q(suffix+'-m@example.invalid')},'authenticated','authenticated');`,
 `update public.profiles set role='admin' where user_id=${q(admin)};update public.profiles set role='manager' where user_id=${q(manager)};`,
 `update public.uber_report_settings set organization_id=${q(org)} where id=1;`,
 `insert into public.drivers(code,name,agency_id,source) values(${q(codes[0])},'Synthetic chosen A',${agency},'manuel'),(${q(codes[1])},'Synthetic no agency',null,'manuel'),(${q(codes[2])},'Synthetic other person',${agency+1},'manuel');`,
 `insert into public.vehicles(key,plate,agency_id) values(${q(vehicle)},${q('SYNTH-'+suffix.slice(0,8))},${agency});`,
 `insert into public.fleet_drivers(id,name,ludy_driver_code,agency_id,vehicle_key,auto_link_disabled,vehicle_link_method) values(${q(fleet)},'Synthetic chosen A',${q(codes[0])},${agency},${q(vehicle)},false,'platform_plate');`,
 `select public.provider_earnings_commit(${j(normalized)}) is not null;`,
 `create temporary table reconcile_before as select to_jsonb(r) value from public.provider_earnings_rows r where organization_id=${q(org)};`,
 auth(admin),
 check(`jsonb_array_length(public.provider_earnings_reconciliation_queue(${snapshot})->'rows')=4`,'admin_sees_all_pending_rows'),
 reject(`perform ${call({revision:999})}`,'stale_revision_refused'),
 reject(`perform ${call({confirmed:false})}`,'explicit_confirmation_required'),
 reject(`perform ${call({row:1})}`,'missing_uuid_cannot_be_manually_invented'),
 reject(`perform ${call({scope:agency+1})}`,'wrong_reference_agency_refused'),
 reject(`perform ${call({proof:'short'})}`,'meaningful_proof_reference_required'),
 reject(`perform ${call({code:'absent'})}`,'nonexistent_reference_refused'),
 reject(`perform ${call({row:2,code:codes[1]})}`,'missing_agency_requires_extra_confirmation'),
 check(`(${call()}->>'awaiting_next_collection')::boolean`,'explicit_identity_confirmation_succeeds'),
 owner,
 check(`(select vehicle_key=${q(vehicle)} and auto_link_disabled=false and vehicle_link_method='platform_plate' and link_method='manual' from public.fleet_drivers where id=${q(fleet)})`,'vehicle_mode_and_assignment_preserved'),
 check(`(select count(*) from public.fleet_link_audit where driver_id=${q(fleet)} and evidence->>'method'='financial_manual_review' and evidence->>'actor'=${q(admin)} and evidence->>'provider_driver_id'=${q(pids[0])})=1`,'actor_and_evidence_audited'),
 check(`not exists((select value from reconcile_before except select to_jsonb(r) from public.provider_earnings_rows r where organization_id=${q(org)}) union all (select to_jsonb(r) from public.provider_earnings_rows r where organization_id=${q(org)} except select value from reconcile_before))`,'confirmation_does_not_rewrite_financial_rows'),
 check(`(select count(*) from public.fleet_identities where source='uber' and organization_id=${q(org)} and external_id=${q(pids[0])} and driver_id=${q(fleet)} and not provisional)=1`,'identity_uses_proven_uuid_exact_scope'),
 auth(admin),
 check(`(${call({row:2,code:codes[1],assign:true})}->>'agency_assigned')::boolean`,'missing_agency_assigned_explicitly'),
 owner,
 check(`(select agency_id=${agency} from public.drivers where code=${q(codes[1])})`,'reference_agency_updated_only_with_confirmation'),
 `insert into public.fleet_drivers(id,name,agency_id) values(${q(conflictFleet)},'Synthetic other person',${agency});`,
 `insert into public.fleet_drivers(id,name,ludy_driver_code,agency_id) values(${q(extraTarget)},'Synthetic empty destination',${q(codes[2])},${agency+1});`,
 `insert into public.fleet_identities(driver_id,source,source_key,external_id,organization_id,provisional) values(${q(conflictFleet)},'uber',${q(org+':'+pids[3])},${q(pids[3])},${q(org)},false);`,
 auth(admin),reject(`perform ${call({row:3,code:codes[2],scope:agency+1})}`,'source_profile_agency_conflict_refused'),
 owner,`update public.fleet_drivers set agency_id=${agency+1} where id=${q(conflictFleet)};`,
 `update public.fleet_drivers set agency_id=${agency} where id=${q(extraTarget)};`,
 auth(admin),reject(`perform ${call({row:3,code:codes[2],scope:agency+1})}`,'destination_profile_agency_conflict_refused'),
 owner,`update public.fleet_drivers set agency_id=${agency+1} where id=${q(extraTarget)};`,
 `update public.fleet_drivers set auto_link_disabled=true,vehicle_link_method='manual' where id=${q(conflictFleet)};`,
 auth(admin),reject(`perform ${call({row:3,code:codes[2],scope:agency+1})}`,'conflicting_vehicle_modes_not_silently_merged'),
 owner,`update public.fleet_drivers set auto_link_disabled=false,vehicle_link_method=null where id=${q(conflictFleet)};`,
 `insert into public.fleet_identities(driver_id,source,source_key,external_id,organization_id,provisional) values(${q(conflictFleet)},'uber',${q(org+':extra')},${q(foreign)},${q(org)},false);`,
 auth(admin),reject(`perform ${call({row:3,code:codes[2],scope:agency+1})}`,'source_second_uuid_cannot_be_silently_merged'),
 owner,`delete from public.fleet_drivers where id=${q(extraTarget)};delete from public.fleet_identities where driver_id=${q(conflictFleet)} and external_id=${q(foreign)};update public.fleet_drivers set ludy_driver_code=${q(codes[2])},link_method='manual' where id=${q(conflictFleet)};`,
 auth(admin),reject(`perform ${call({row:3})}`,'existing_other_person_refused'),
 reject(`perform ${call({row:2})}`,'chosen_person_already_has_another_uuid_refused'),
 auth(manager),reject(`perform public.provider_earnings_reconciliation_queue(null)`,'manager_cannot_read_global_queue'),reject(`perform ${call()}`,'manager_cannot_confirm'),
 owner,`update public.profiles set role='viewer' where user_id=${q(admin)};`,auth(admin),reject(`perform ${call()}`,'role_revoked_before_write_refused'),
 owner,`update public.profiles set role='admin' where user_id=${q(admin)};`,
 `select public.provider_earnings_commit(${j(normalized)}) is not null;`,
 check(`(select count(*) from public.provider_earnings_rows where organization_id=${q(org)} and mapping_status='confirmed')=3`,'next_normal_collection_uses_confirmed_identities'),
 check(`(select provider_driver_id is null and mapping_status='unmatched' and agency_id is null from public.provider_earnings_rows where organization_id=${q(org)} and provider_row=1)`,'unproved_identity_remains_unassigned'),
 check(`not exists(select 1 from public.provider_earnings_rows r join reconcile_before b on (b.value->>'provider_row')::int=r.provider_row where r.organization_id=${q(org)} and r.amounts<>b.value->'amounts')`,'all_financial_amounts_preserved_after_recollect'),
 auth(admin),reject(`perform ${call()}`,'old_ui_revision_invalid_after_recollect'),
 auth(randomUUID()),reject('perform public.provider_earnings_reconciliation_queue(null)','session_without_profile_denied'),
 owner,'set local role anon;',reject('perform public.provider_earnings_reconciliation_queue(null)','anonymous_queue_denied'),
 owner,'set local role service_role;',reject('perform public.provider_earnings_reconciliation_queue(null)','service_role_cannot_impersonate_reviewer'),
 owner,'rollback;'].join('\n');
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(v=>v==='--username=postgres'?'--username=supabase_admin':v),{input:sql,encoding:'utf8',timeout:45000,maxBuffer:1048576,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)))});
if(result.error||result.status!==0){writeFileSync(new URL('../.local/checks/reconciliation-sql-private-error.log',import.meta.url),String(result.stderr),{mode:0o600});chmodSync(new URL('../.local/checks/reconciliation-sql-private-error.log',import.meta.url),0o600);throw Error('Local reconciliation rollback failed: '+(String(result.stderr).match(/reconciliation-test: ([a-z_0-9]+)/)?.[1]||'SQL validation'));}
assert.equal(result.stdout.trim(),'t\nt');console.log(JSON.stringify({ok:true,checks,rolledBack:true,target:'local-staging-only'}));
