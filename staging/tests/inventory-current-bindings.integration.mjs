// Guarded local regression. Synthetic rows and migration replay roll back together.
import assert from 'node:assert/strict';import {randomUUID,randomInt} from 'node:crypto';import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';import {assertLocalProject} from '../scripts/guard.mjs';
assertLocalProject();assert.equal(process.argv.length,2);
const suffix=randomUUID(),q=v=>"'"+String(v).replaceAll("'","''")+"'",j=v=>q(JSON.stringify(v))+'::jsonb',id=n=>'reconcile-'+n+'-'+suffix;
const canonical=Date.now()*1000+randomInt(999),duplicate=canonical+1,ambiguous=canonical+2,city='Synthetic City '+suffix,agencyName='Agence '+city,stamp='2020-01-01T00:00:00Z',driver=id('driver'),manual=id('manual'),profile=randomUUID(),manager=randomUUID();
const car=(n,extra={})=>({external_id:id(n),reference:id('ref-'+n),plate:id('plate-'+n),temporary_plate:'',brand:'Synthetic',model:'Test',vin:id('vin-'+n),fuel:'DIESEL',status:'AVAILABLE',is_blocked:false,archived:false,deleted_at:null,provider_updated_at:stamp,...extra});
const current=car('current'),old=car('old',{vin:current.vin,archived:true,deleted_at:stamp}),newCar=car('new'),vehicles=[current,old,newCar],agencies=[{external_id:id('agency'),code:id('agency-code'),name:agencyName,provider_updated_at:stamp}],newKey='myclicar:'+newCar.external_id,key=id('existing-key');
const contract={external_id:id('contract'),num:id('contract-num'),client_code:driver,name:'Synthetic driver',plate:newCar.plate,temporary_plate:'',model:'Synthetic',status:'IN_PROGRESS',start_at:stamp,effective_start_at:stamp,end_at:null,provider_updated_at:stamp,deleted:false,vehicle_key:newKey,vehicle_candidates:[newKey],current:true,eligible:false,reason:'provider_agency_mismatch',agency_id:duplicate,vehicle_external_id:newCar.external_id,departure_agency_external_id:id('agency'),details_verified:true};
let checks=0;const check=(condition,label)=>{checks++;return `do $t$ begin if (${condition}) is distinct from true then raise exception 'binding-test: ${label}';end if;end $t$;`;};
const run=expression=>`do $w$ begin perform ${expression};end $w$;`;
const sync=rows=>`public.fleet_sync_inventory(${j(rows)},${j(agencies)},now())`;
const migration=readFileSync(new URL('../supabase/migrations/20261210000000_inventory_current_bindings.sql',import.meta.url),'utf8').replace('create function public.fleet_myclicar_agency_label(','create or replace function public.fleet_myclicar_agency_label(');
const renewal=car('renewed',{vin:current.vin}),noVin=car('no-vin',{plate:newCar.plate,vin:''});
const sql=[`begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;`,LOCAL_GUARD,"load 'safeupdate';",run("pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0))"),
 `insert into agencies(id,name,city) overriding system value values(${canonical},${q(id('canonical-office'))},${q(city)}),(${duplicate},${q(agencyName)},null);`,
 `insert into vehicles(key,plate,vin,agency_id,geotab_id,active,geotab_auto_link_disabled) values(${q(key)},${q(current.plate)},${q(current.vin)},${canonical},'SYNTHETIC-GPS','OUI',true);`,
 `insert into vehicles(key,plate,vin,agency_id,myclicar_external_id,active) values(${q(newKey)},${q(newCar.plate)},${q(newCar.vin)},${duplicate},${q(newCar.external_id)},'OUI');`,
 `insert into drivers(code,name,agency_id,source) values(${q(driver)},'Synthetic driver',${duplicate},'myclicar'),(${q(manual)},'Manual driver',${duplicate},'manuel');`,
 `insert into fleet_drivers(id,name,ludy_driver_code,agency_id,link_method) values(${q(profile)},'Synthetic driver',${q(driver)},${duplicate},'exact_name');`,
 `insert into auth.users(id,email,aud,role) values(${q(manager)},${q(id('manager')+'@example.invalid')},'authenticated','authenticated');update profiles set role='manager' where user_id=${q(manager)};insert into user_agencies(user_id,agency_id) values(${q(manager)},${duplicate});`,
 `update fleet_myclicar_vehicles set current=false where current;update fleet_myclicar_agencies set current=false where current;update fleet_myclicar_contracts set current=false where current;`,
 `insert into fleet_myclicar_agencies(external_id,code,name,agency_id,provider_updated_at,observed_at) values(${q(agencies[0].external_id)},${q(agencies[0].code)},${q(agencyName)},${duplicate},${q(stamp)},now());`,
 `insert into fleet_myclicar_vehicles(external_id,reference,plate,temporary_plate,brand,model,vin,fuel,status,is_blocked,archived,deleted_at,provider_updated_at,reason,observed_at) select external_id,reference,plate,temporary_plate,brand,model,vin,fuel,status,is_blocked,archived,deleted_at,provider_updated_at,'ambiguous_vehicle',now() from jsonb_populate_recordset(null::fleet_myclicar_vehicles,${j(vehicles)});`,
 `insert into fleet_myclicar_contracts select (jsonb_populate_record(null::fleet_myclicar_contracts,${j(contract)}||jsonb_build_object('observed_at',now()))).*;`,
 `update fleet_inventory_sync set status='healthy',last_success_at=now(),last_attempt_at=now() where id=1;`,migration,
 check(`(select agency_id=${canonical} from fleet_myclicar_agencies where external_id=${q(agencies[0].external_id)})`,'agency_binding_canonical'),
 check(`(select value::jsonb->>${q(duplicate)}=${q(canonical)} from params where key='myclicar_agency_aliases')`,'alias_marker_without_hardcoded_ids'),
 check(`(select count(*) from fleet_myclicar_vehicles where current and not archived and vehicle_key is not null)=2`,'archives_do_not_compete_with_current'),
 check(`(select reason='archived_reference' and vehicle_key is null from fleet_myclicar_vehicles where external_id=${q(old.external_id)})`,'history_has_no_current_claim'),
 check(`(select geotab_id='SYNTHETIC-GPS' and geotab_auto_link_disabled and agency_id=${canonical} from vehicles where key=${q(key)})`,'manual_vehicle_settings_preserved'),
 check(`(select agency_id=${canonical} from vehicles where key=${q(newKey)})`,'new_imported_vehicle_repaired'),
 check(`(select agency_id=${canonical} from drivers where code=${q(driver)})`,'new_imported_driver_repaired'),
 check(`(select agency_id=${canonical} from fleet_drivers where id=${q(profile)})`,'automatic_profile_repaired'),
 check(`(select agency_id=${duplicate} from drivers where code=${q(manual)})`,'manual_driver_agency_preserved'),
 check(`exists(select 1 from user_agencies where user_id=${q(manager)} and agency_id=${duplicate}) and not exists(select 1 from user_agencies where user_id=${q(manager)} and agency_id=${canonical})`,'manager_access_not_reassigned'),
 check(`(select eligible and reason='matched' and observed_at=now() from fleet_myclicar_contracts where external_id=${q(contract.external_id)})`,'same_snapshot_contract_reconciled'),
 check(`(select last_success_at=now() from fleet_inventory_sync where id=1)`,'observation_time_unchanged'),
 check(`(${sync(vehicles)}->>'matched_vehicles')::int=2`,'reimport_idempotent'),
 run(sync([{...current,archived:true,deleted_at:stamp},renewal,newCar])),
 check(`(select myclicar_external_id=${q(renewal.external_id)} and geotab_id='SYNTHETIC-GPS' from vehicles where key=${q(key)})`,'archived_reference_renewed_only_with_same_vin'),
 check(`(select vehicle_key=${q(key)} from fleet_myclicar_vehicles where external_id=${q(renewal.external_id)})`,'renewal_keeps_same_vehicle'),
 run(sync([renewal,{...newCar,archived:true,deleted_at:stamp},noVin])),
 check(`(select vehicle_key is null from fleet_myclicar_vehicles where external_id=${q(noVin.external_id)})`,'plate_without_vin_cannot_take_archived_binding'),
 check(`(select myclicar_external_id=${q(newCar.external_id)} from vehicles where key=${q(newKey)})`,'ambiguous_renewal_preserves_binding'),
 run(sync([renewal,car('duplicate',{plate:renewal.plate,vin:renewal.vin})])),
 check(`(select count(*) from fleet_myclicar_vehicles where current and not archived and reason='ambiguous_vehicle' and vehicle_key is null)=2`,'two_current_duplicates_still_refused'),
 // With no pre-existing provider binding, exact normalized agency/city resolves once.
 `delete from fleet_myclicar_agencies where external_id=${q(agencies[0].external_id)};`,
 `update agencies set name=${q(id('retired-alias'))} where id=${duplicate};`,run(sync([newCar])),
 check(`(select agency_id=${canonical} from fleet_myclicar_agencies where external_id=${q(agencies[0].external_id)})`,'new_import_reuses_unique_city'),
 check(`not exists(select 1 from agencies where name=${q(agencyName)})`,'new_import_does_not_create_duplicate_agency'),
 `delete from fleet_myclicar_agencies where external_id=${q(agencies[0].external_id)};insert into agencies(id,name,city) overriding system value values(${ambiguous},${q(id('other-office'))},${q(city)});`,run(sync([newCar])),
 check(`(select agency_id is null from fleet_myclicar_agencies where external_id=${q(agencies[0].external_id)})`,'multiple_agencies_same_city_remain_unresolved'),
 'rollback;'].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k))),args=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x);
const result=spawnSync('docker',args,{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});if(result.status!==0||result.error){const label=String(result.stderr).match(/binding-test: ([a-z_]+)/)?.[1],state=String(result.stderr).match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Binding regression rolled back: '+(label||state||'local check failed'));}assert.equal(result.stdout.trim(),'');console.log(JSON.stringify({ok:true,checks,rolledBack:true,migrationInTransaction:true}));
