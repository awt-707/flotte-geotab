import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
assertLocalProject();
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key))),docker=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(a=>a==='--username=postgres'?'--username=supabase_admin':a);
const run=sql=>spawnSync('docker',docker,{env,input:sql,encoding:'utf8',timeout:40000,maxBuffer:1024*1024});
const dependencies=run(LOCAL_GUARD+"select exists(select 1 from information_schema.columns where table_schema='public' and table_name='fleet_rides' and column_name='requested_at');select to_regclass('public.fleet_driver_report_summaries') is not null;");if(dependencies.status!==0)throw Error('Pinned local database unavailable');
const [has36,has39]=dependencies.stdout.trim().split('\n').map(v=>v==='t'),agency=Date.now()*1000+randomInt(900),org=randomUUID(),otherOrg=randomUUID(),driver=randomUUID(),namesake=randomUUID(),outside=randomUUID(),provider=randomUUID(),ride=randomUUID(),admin=randomUUID(),viewer=randomUUID();
const q=v=>"'"+String(v).replaceAll("'","''")+"'",json=v=>q(JSON.stringify(v))+'::jsonb',revision='(select revision from public.uber_report_settings where id=1)',from='2026-10-25T23:00:00Z',to='2026-11-01T23:00:00Z';
const base={provider_driver_id:provider,driver_name:'Synthetic Driver',external_id:ride,status:'completed',requested_at:'2026-11-01T10:00:00Z',started_at:null,finished_at:'2026-11-01T11:00:00Z',distance_km:12.5,provider_vehicle_id:null,vehicle_label:'SYNTHETIC'};
const summary={provider_driver_id:provider,driver_name:'Synthetic Driver',trips_completed:14,online_seconds:95400,trip_seconds:44100,acceptance_rate:null,cancellation_rate:null,completion_rate:null,accepted_count:null,rejected_count:null,cancelled_count:null};
const commit=(rows=[base],type='trip_activity',batches=[],hash='a'.repeat(64),rev=revision)=>`public.uber_driver_report_commit(${q(org)}::uuid,${rev},${q(hash)},${q(type)},${json(batches)},${json(rows)},'{"received":1,"imported":0}'::jsonb,${q(from)}::timestamptz,${q(to)}::timestamptz)`;
let checks=0;const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'uber-driver-test: ${label}';end if;end $test$;`;};
const reject=(statement,label,exception='others')=>{checks++;return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'uber-driver-test: ${label}';end if;end $test$;`;};
const sql=["begin;set local lock_timeout='2s';set local statement_timeout='20s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(!has36?[readFileSync(new URL('../supabase/migrations/20261206000000_driver_performance.sql',import.meta.url),'utf8')]:[]),...(!has39?[readFileSync(new URL('../supabase/migrations/20261209000000_uber_driver_reports.sql',import.meta.url),'utf8')]:[]),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic report Casa','Casablanca'),(${agency+1},'Synthetic report outside','Marrakech');`,
 `insert into auth.users(id,email,aud,role) values(${q(admin)},${q(admin+'@example.invalid')},'authenticated','authenticated'),(${q(viewer)},${q(viewer+'@example.invalid')},'authenticated','authenticated');update public.profiles set role='admin' where user_id=${q(admin)};update public.profiles set role='viewer' where user_id=${q(viewer)};`,
 `insert into public.fleet_drivers(id,name,agency_id) values(${q(driver)},'Synthetic Driver',${agency}),(${q(namesake)},'Other Driver',${agency}),(${q(outside)},'Outside Driver',${agency+1});`,
 `insert into public.fleet_identities(driver_id,source,source_key,external_id,organization_id,provisional) values(${q(driver)},'uber',${q(randomUUID())},${q(provider)},${q(org)},false),(${q(namesake)},'uber',${q(randomUUID())},null,${q(org)},true),(${q(outside)},'uber',${q(randomUUID())},${q(randomUUID())},${q(org)},false);`,
 `select public.uber_report_configure(true,${q(org)}::uuid,${json({Casablanca:agency})},'ymd',${q(admin)}::uuid) is not null;`,
 ...['anon','authenticated'].flatMap(role=>[`reset role;set local role ${role};`,reject(`perform ${commit()}`,role+'_cannot_import','insufficient_privilege'),reject('perform 1 from public.uber_driver_report_imports',role+'_cannot_read_journal','insufficient_privilege')]),
 'reset role;set local role service_role;',reject(`perform ${commit([base],'trip_activity',[],'a'.repeat(64),revision+'-1')}`,'old_revision_refused'),
 check(`(${commit()}->'counts'->>'driver_imported')::integer=1`,'uuid_association'),
 check(`(select driver_id=${q(driver)}::uuid and started_at is null and duration_s is null and amount is null and currency is null and detail_origin='uber_report' from public.fleet_rides where source='uber' and organization_id=${q(org)} and external_id=${q(ride)})`,'no_invented_measures'),
 check(`(${commit()}->>'duplicate')::boolean`,'same_report_deduplicated'),check(`(select count(*) from public.fleet_rides where organization_id=${q(org)})=1`,'no_duplicate_rides'),
 check(`(${commit([{...base,external_id:randomUUID(),provider_driver_id:null}])}->'counts'->>'driver_imported')::integer=1`,'unique_full_name_fallback'),
 check(`(${commit([{...base,external_id:randomUUID(),provider_driver_id:randomUUID()}])}->'counts'->>'driver_unmatched')::integer=1`,'unknown_uuid_never_falls_back_to_name'),
 `update public.fleet_drivers set name='Synthetic Driver' where id=${q(outside)};`,
 check(`(${commit([{...base,external_id:randomUUID(),provider_driver_id:null}])}->'counts'->>'driver_unmatched')::integer=1`,'same_org_namesake_outside_scope_remains_ambiguous'),
 `update public.fleet_drivers set name='Outside Driver' where id=${q(outside)};`,
 check(`public.uber_report_driver(${q(otherOrg)},${q(provider)},'Synthetic Driver',${json({Casablanca:agency})}) is null`,'organization_scoped_identity'),
 check(`(${commit([summary],'driver_activity')}->'counts'->>'driver_imported')::integer=1`,'activity_summary_saved'),
 check(`(select online_seconds=95400 and trip_seconds=44100 and acceptance_rate is null from public.fleet_driver_report_summaries where organization_id=${q(org)})`,'official_time_units'),
 reject(`perform ${commit([{...summary,acceptance_rate:2}],'driver_quality')}`,'invalid_quality_rolls_back'),check(`not exists(select 1 from public.fleet_driver_report_summaries where organization_id=${q(org)} and report_type='driver_quality')`,'no_partial_summary'),
 reject(`perform ${commit([{...base,distance_km:22}],'trip_activity',[{city:'Marrakech',agency_id:agency+1,rows:[]}])}`,'demand_failure_rolls_back_rides'),check(`(select distance_km=12.5 from public.fleet_rides where organization_id=${q(org)} and external_id=${q(ride)})`,'atomic_ride_and_demand'),
 `reset role;set local request.jwt.claims=${q(JSON.stringify({sub:viewer,role:'authenticated'}))};set local role authenticated;`,
 check(`not exists(select 1 from public.fleet_driver_report_summaries where organization_id=${q(org)})`,'viewer_without_agency_cannot_read'),
 `reset role;set local request.jwt.claims=${q(JSON.stringify({sub:admin,role:'authenticated'}))};set local role authenticated;`,
 check(`(select count(*) from public.fleet_driver_report_summaries where organization_id=${q(org)})=1`,'administrator_can_read'),
 "reset role;rollback;select 'UBER_DRIVER_ROLLBACK_OK';"
].join('\n');
const result=run(sql);if(result.error||result.status!==0){const label=String(result.stderr||'').match(/uber-driver-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Local Uber driver report validation failed; transaction rolled back.'+(label?' Check: '+label:state?' SQLSTATE: '+state:''));}
assert.equal(result.stdout.trim(),'t\nUBER_DRIVER_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration36_simulated:!has36,migration39_simulated:!has39,rolled_back:true}));
