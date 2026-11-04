import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {normalizeUberCsv} from '../server/uber-reports.mjs';
assertLocalProject();
const args=process.argv.slice(2);if(args.length>1||args.some(arg=>arg!=='--with-migration'))throw Error('Only --with-migration supported');
const simulate=args.includes('--with-migration'),suffix=randomUUID(),org=randomUUID(),admin=randomUUID(),viewer=randomUUID(),agency=Date.now()*1000+randomInt(900),q=value=>"'"+String(value).replaceAll("'","''")+"'",json=value=>q(JSON.stringify(value))+'::jsonb';
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const docker=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(arg=>arg==='--username=postgres'?'--username=supabase_admin':arg);
const run=sql=>spawnSync('docker',docker,{env,input:sql,encoding:'utf8',timeout:40000,maxBuffer:1024*1024});
const dependency=run(LOCAL_GUARD+"select to_regclass('public.ops_demand_imports') is not null;");if(dependency.status!==0)throw Error('Pinned staging database unavailable');
const needsDemand=dependency.stdout.trim()==='f';if(needsDemand&&!simulate)throw Error('Operations migration required');
const config={enabled:true,organization_id:org,city_agencies:{Casablanca:agency,Marrakech:agency+1},date_format:'ymd'};
const csv='Trip UUID,Trip request time,Pickup address,Trip status\n'+randomUUID()+',2026-11-01T10:00:00Z,"12 Rue Test, Casablanca",completed\n'+randomUUID()+',2026-11-01T11:00:00Z,"34 Rue Test, Marrakech",completed';
const normalized=normalizeUberCsv(csv,config,{now:Date.parse('2026-11-02T10:00:00Z')}),revision='(select revision from public.uber_report_settings where id=1)';
const configure=(mapping=config.city_agencies,user=admin,enabled=true)=>`public.uber_report_configure(${enabled},${q(org)}::uuid,${json(mapping)},'ymd',${q(user)}::uuid)`;
const commit=(batches=normalized.batches,fileHash=normalized.file_sha256,rev=revision,organization=org)=>`public.uber_report_commit(${q(organization)}::uuid,${rev},${q(fileHash)},${json(batches)},${json(normalized.counts)})`;
let checks=0;const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'uber-report-test: ${label}';end if;end $test$;`;};
const reject=(statement,label,exception='others')=>{checks++;return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'uber-report-test: ${label}';end if;end $test$;`;};
const perform=statement=>`do $work$ begin perform ${statement};end $work$;`;
const badSecond=structuredClone(normalized.batches);badSecond[1].rows[0].status='invalid';
const sql=["begin;set local lock_timeout='2s';set local statement_timeout='20s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(simulate&&needsDemand?[readFileSync(new URL('../supabase/migrations/20261129000000_operations_growth.sql',import.meta.url),'utf8')]:[]),
 ...(simulate?[readFileSync(new URL('../supabase/migrations/20261202000000_uber_report_sync.sql',import.meta.url),'utf8')]:[]),
 ...(simulate?[check('(select not enabled and organization_id is null from public.uber_report_settings where id=1)','disabled_by_default')]:[]),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic Uber Casa','CASABLANCA'),(${agency+1},'Synthetic Uber Marrakech','Marrakech');`,
 `insert into auth.users(id,email,aud,role) values(${q(admin)},${q('uber-report-admin-'+suffix+'@example.invalid')},'authenticated','authenticated'),(${q(viewer)},${q('uber-report-viewer-'+suffix+'@example.invalid')},'authenticated','authenticated');`,
 `update public.profiles set role='admin' where user_id=${q(admin)};update public.profiles set role='viewer' where user_id=${q(viewer)};`,
 ...['anon','authenticated'].flatMap(role=>[`reset role;set local role ${role};`,
 ...['uber_report_settings','uber_report_import_log'].map(table=>reject(`perform 1 from public.${table} limit 1`,role+'_cannot_read_'+table,'insufficient_privilege')),
 reject(`perform ${configure()}`,role+'_cannot_configure_rpc','insufficient_privilege'),reject(`perform ${commit()}`,role+'_cannot_commit_rpc','insufficient_privilege')]),
 'reset role;set local role service_role;',
 reject(`perform ${configure(config.city_agencies,viewer)}`,'nonadmin_configuration_refused'),
 reject(`perform ${configure({Marrakech:agency})}`,'wrong_city_mapping_refused'),
 reject(`perform ${configure({Casablanca:agency+10})}`,'unknown_agency_mapping_refused'),
 perform(configure()),check(`(select enabled and city_agencies=${json(config.city_agencies)} from public.uber_report_settings where id=1)`,'configuration_saved'),
 reject(`perform ${commit(normalized.batches,normalized.file_sha256,revision+'-1')}`,'old_config_revision_refused'),
 reject(`perform ${commit(normalized.batches,normalized.file_sha256,revision,randomUUID())}`,'wrong_organization_refused'),
 reject(`perform ${commit([{...normalized.batches[0],agency_id:agency+1}])}`,'import_agency_mismatch_refused'),
 reject(`perform ${commit(badSecond)}`,'second_city_failure_rolls_back_both'),
 check(`not exists(select 1 from public.ops_demand_imports where agency_id in(${agency},${agency+1}))`,'no_partial_city_import'),
 check(`not exists(select 1 from public.ops_demand_rides where agency_id in(${agency},${agency+1}))`,'no_partial_city_rides'),
 check(`not exists(select 1 from public.uber_report_import_log where organization_id=${q(org)})`,'no_failed_journal'),
 check(`not (${commit()}->>'duplicate')::boolean`,'two_city_commit_success'),
 check(`(select count(*) from public.ops_demand_rides where agency_id in(${agency},${agency+1}))=2`,'two_rides_saved'),
 check(`(select count(*) from public.uber_report_import_log where organization_id=${q(org)})=1`,'one_metadata_journal'),
 check(`(select counts->>'imported'='2' and jsonb_array_length(results)=2 from public.uber_report_import_log where organization_id=${q(org)})`,'counts_and_city_results_kept'),
 check(`not exists(select 1 from public.ops_demand_rides where agency_id in(${agency},${agency+1}) and pickup_zone~'^(12|34) ')`,'street_numbers_removed_before_storage'),
 "update public.uber_report_settings set last_status='error',last_error='Synthetic previous error' where id=1;",
 check(`(${commit()}->>'duplicate')::boolean`,'file_retry_deduplicated'),
 check(`(select count(*) from public.uber_report_import_log where organization_id=${q(org)})=1`,'retry_no_extra_journal'),
 check(`(select last_status='imported' and last_error is null from public.uber_report_settings where id=1)`,'successful_duplicate_clears_old_error'),
 perform(commit([],'e'.repeat(64))),check("(select last_status='empty' from public.uber_report_settings where id=1)",'excluded_only_report_is_explicit_empty'),
 perform(configure(config.city_agencies,admin,false)),reject(`perform ${commit()}`,'disabled_collection_refused'),
 "update public.params set value='not-staging' where key='environment';",reject(`perform ${configure()}`,'configuration_requires_staging'),reject(`perform ${commit()}`,'commit_requires_staging'),
 "reset role;rollback;select 'UBER_REPORTS_ROLLBACK_OK';"
].join('\n');
const result=run(sql);if(result.error||result.status!==0){const label=String(result.stderr||'').match(/uber-report-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Local Uber report validation failed; rollback retained.'+(label?' Check: '+label:state?' SQLSTATE: '+state:''));}
assert.equal(result.stdout.trim(),'UBER_REPORTS_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:simulate,demand_dependency_simulated:simulate&&needsDemand,rolled_back:true}));
