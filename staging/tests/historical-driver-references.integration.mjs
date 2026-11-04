// Guarded local SQL only. Fixture data and optional migration are rolled back.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
assertLocalProject();
const withMigration=process.argv.includes('--with-migration');
if(process.argv.slice(2).some(x=>x!=='--with-migration'))throw Error('Unsupported option');
const suffix=randomUUID(),q=x=>"'"+String(x).replaceAll("'","''")+"'",json=x=>q(JSON.stringify(x))+'::jsonb';
const id=()=>randomUUID(),canonical=id(),incoming=id(),unrelated=id(),identity=id();
const code='REF-'+suffix,car='CAR-'+suffix,external='CAT-'+suffix,returned='RETURN-'+suffix;
const good='HIST-'+suffix,unverified='UNVERIFIED-'+suffix,mismatch='MISMATCH-'+suffix,ambiguous='AMBIGUOUS-'+suffix;
const portalCode='PORTAL-'+suffix,linkedCode='LINKED-'+suffix,orphanCode='ORPHAN-'+suffix,protectedCode='CLICAR-'+suffix;
const name='Synthetic Émile Ben-Ali '+suffix,platform='BEN ALI EMILE SYNTHETIC '+suffix,org='fixture-'+suffix;
const now=Date.now()-1000,at=new Date(now).toISOString(),from=new Date(now-7*86400000).toISOString(),start=new Date(now-7200000).toISOString(),end=new Date(now-3600000).toISOString();
const row={external_id:returned,num:returned,client_code:good,name:'Synthetic Returned Driver '+suffix,plate:car,status:'DONE',effective_start_at:start,end_at:end,deleted:false,details_verified:true,vehicle_external_id:external};
const rpc=rows=>`public.fleet_sync_rotation_contracts(${json(rows)},${q(at)},${q(from)},${q(at)})`;
const link=(driver=incoming,driverName=platform)=>`public.fleet_auto_link_driver(${q(driver)},${q(code)},${q(driverName)},${q(name)})`;
let checks=0;
const check=(condition,label)=>{checks++;return `do $check$ begin if (${condition}) is distinct from true then raise exception 'reference-test:${label}';end if;end $check$;`;};
const denied=expression=>{checks++;return `do $check$ declare refused boolean:=false;begin begin perform ${expression};exception when insufficient_privilege then refused:=true;end;if not refused then raise exception 'reference-test:permission';end if;end $check$;`;};
const sql=["begin;load 'safeupdate';set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,
  ...(withMigration?[readFileSync(new URL('../supabase/migrations/20261214000000_historical_driver_references.sql',import.meta.url),'utf8')]:[]),
  `insert into public.vehicles(key,plate) values(${q(car)},${q(car)});
   insert into public.fleet_myclicar_vehicles(external_id,reference,plate,status,vehicle_key,observed_at) values(${q(external)},${q(external)},${q(car)},'AVAILABLE',${q(car)},${q(at)});
   update public.fleet_rotation_sync set last_success_at=null where id=1;
   insert into public.drivers(code,name,source) values(${q(code)},${q(name)},'manuel');
   insert into public.fleet_drivers(id,name,ludy_driver_code,auto_link_disabled,link_method) values(${q(canonical)},${q(name)},${q(code)},true,'manual');
   insert into public.fleet_drivers(id,name) values(${q(incoming)},${q(platform)}),(${q(unrelated)},'Entirely Different Person');
   insert into public.fleet_identities(id,driver_id,source,source_key,organization_id) values(${q(identity)},${q(incoming)},'uber',${q(org)},${q(org)});
   insert into public.fleet_driver_performance_sync(source,organization_id,driver_id,covered_from,covered_to,last_success_at,status,row_count)
     values('uber',${q(org)},${q(incoming)},${q(start)},${q(end)},${q(at)},'healthy',7);
   insert into public.fleet_driver_report_summaries(source,organization_id,driver_id,report_type,period_from,period_to,reported_at,trips_completed,online_seconds)
     values('uber',${q(org)},${q(incoming)},'driver_activity',${q(start)},${q(end)},${q(at)},7,3600);
   insert into public.fleet_link_audit(driver_id,action,method,evidence) values(${q(incoming)},'fixture','exact_name','{}');
   set local role service_role;`,
  check(`${link()} is null`,'manual_canonical_not_overridden'),
  `update public.fleet_drivers set auto_link_disabled=false where id=${q(canonical)};`,
  check(`${link(unrelated,'Entirely Different Person')} is null`,'unrelated_names_rejected'),
  `insert into public.drivers(code,name) values(${q(code+'-duplicate')},${q(platform)});`,
  check(`${link()} is null`,'new_homonym_race_rechecked'),
  `delete from public.drivers where code=${q(code+'-duplicate')};`,
  check(`${link()}=${q(canonical)}::uuid`,'accent_order_punctuation_exact_merge'),
  check(`not exists(select 1 from public.fleet_drivers where id=${q(incoming)}) and (select driver_id=${q(canonical)} from public.fleet_identities where id=${q(identity)})`,'identity_merged'),
  check(`(select row_count=7 and status='healthy' from public.fleet_driver_performance_sync where driver_id=${q(canonical)} and organization_id=${q(org)})`,'performance_preserved'),
  check(`(select trips_completed=7 and online_seconds=3600 from public.fleet_driver_report_summaries where driver_id=${q(canonical)} and organization_id=${q(org)})`,'report_summary_preserved'),
  check(`exists(select 1 from public.fleet_link_audit where driver_id=${q(canonical)} and action='fixture')`,'merge_audit_preserved'),
  check(`(${rpc([row])}->>'driver_references_created')::integer=1`,'verified_return_creates_reference'),
  check(`(select name=${q(row.name)} and source='myclicar' and status='INACTIF' and agency_id is null from public.drivers where code=${q(good)})`,'historical_reference_not_current_duty'),
  check(`(select details_verified and name=${q(row.name)} and vehicle_external_id=${q(external)} from public.fleet_rotation_contracts where external_id=${q(returned)})`,'history_provenance_retained'),
  check(`not exists(select 1 from public.fleet_myclicar_contracts where client_code=${q(good)})`,'no_active_contract_invented'),
  check(`(${rpc([row])}->>'driver_references_created')::integer=0`,'reference_creation_idempotent'),
  `update public.drivers set name='Operator corrected name',source='manuel' where code=${q(good)};`,
  check(`(${rpc([row])}->>'driver_references_created')::integer=0 and (select name='Operator corrected name' and source='manuel' from public.drivers where code=${q(good)})`,'operator_reference_preserved'),
  check(`(${rpc([{...row,external_id:returned+'-u',num:returned+'-u',client_code:unverified,details_verified:false},{...row,external_id:returned+'-m',num:returned+'-m',client_code:mismatch,vehicle_external_id:'unknown-'+suffix},{...row,external_id:returned+'-a',num:returned+'-a',client_code:ambiguous,name:'Synthetic Person One'},{...row,external_id:returned+'-b',num:returned+'-b',client_code:ambiguous,name:'Synthetic Person Two'}])}->>'driver_references_created')::integer=0`,'uncertain_reference_not_created'),
  check(`not exists(select 1 from public.drivers where code in(${q(unverified)},${q(mismatch)},${q(ambiguous)}))`,'uncertain_codes_absent'),
  `insert into public.drivers(code,name,source) values(${q(portalCode)},'Synthetic Portal Driver','contrats'),(${q(linkedCode)},'Synthetic Linked Driver','contrats'),(${q(orphanCode)},'Synthetic Orphan Driver','contrats'),(${q(protectedCode)},'Current MyClicar Name','myclicar');
   insert into public.fleet_drivers(id,name,ludy_driver_code) values(${q(id())},'Synthetic Linked Driver',${q(linkedCode)});
   insert into public.driver_portal_accounts(ludy_driver_code,display_name,credential_hash) values(${q(portalCode)},'Synthetic Portal Driver',${q((suffix+suffix).replaceAll('-',''))});
   insert into public.contracts(num,client_code,name,start_at) values(${q('LEGACY-'+suffix)},${q(protectedCode)},'Obsolete contract name',${q(start)});
   do $$ begin perform public.refresh_drivers();end $$;`,
  check(`(select count(*) from public.drivers where code in(${q(portalCode)},${q(linkedCode)},${q(code)},${q(good)},${q(protectedCode)}))=5`,'legacy_refresh_preserves_external_manual_linked_portal'),
  check(`(select name='Current MyClicar Name' and source='myclicar' from public.drivers where code=${q(protectedCode)})`,'legacy_contract_cannot_replace_external_name'),
  check(`not exists(select 1 from public.drivers where code=${q(orphanCode)})`,'legacy_refresh_removes_only_own_unused_reference'),
  `do $$ begin perform public.refresh_drivers();end $$;`,
  check(`(select count(*) from public.drivers where code=${q(portalCode)})=1`,'legacy_refresh_repeat_same_transaction'),
  'reset role;set local role authenticated;',denied(rpc([row])),denied(link()),
  'reset role;set local role service_role;',denied(`public.fleet_link_driver_reference_base(${q(canonical)},${q(code)},null,null)`),
  'reset role;rollback;',"select 'REFERENCE_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const args=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x);
const result=spawnSync('docker',args,{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
if(result.status!==0){const label=result.stderr?.match(/reference-test:([a-z_]+)/)?.[1];throw Error('Local references verification failed; rollback. '+(label||String(result.stderr).replaceAll(suffix,'fixture').slice(0,1200)));}
assert.equal(result.stdout.trim(),'REFERENCE_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,rolled_back:true,migration_simulated:withMigration}));
