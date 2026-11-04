// Synthetic data only, guarded local PostgreSQL, every assertion rolls back.
import assert from 'node:assert/strict';import {randomUUID,randomInt} from 'node:crypto';import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';import {assertLocalProject} from '../scripts/guard.mjs';
assertLocalProject();const args=process.argv.slice(2);assert.ok(args.every(x=>x==='--with-migration')&&args.length<=1);
const suffix=randomUUID(),q=s=>"'"+String(s).replaceAll("'","''")+"'",json=v=>q(JSON.stringify(v))+'::jsonb';
const agency=Date.now()*1000+randomInt(999),manager=randomUUID(),admin=randomUUID(),key='inventory-existing-'+suffix,plate='SYN-'+suffix,code='inventory-driver-'+suffix;
const id=n=>'inventory-'+n+'-'+suffix,name='Synthetic inventory '+suffix;
const vehicle=(n,extra={})=>({external_id:id(n),reference:id('ref-'+n),plate:plate+'-'+n,temporary_plate:'',brand:'Synthetic',model:'Test',vin:'VIN-'+suffix+'-'+n,fuel:'DIESEL',status:'AVAILABLE',is_blocked:false,archived:false,provider_updated_at:'2020-01-01T00:00:00Z',deleted_at:null,...extra});
const rows=[vehicle('existing',{plate,vin:'VIN-'+suffix}),vehicle('unused'),vehicle('rented',{status:'RENTED'}),vehicle('archived',{archived:true,deleted_at:'2020-01-01T00:00:00Z'}),vehicle('duplicate1',{plate:'DUP-'+suffix}),vehicle('duplicate2',{plate:'DUP-'+suffix}),vehicle('conflict',{plate,vin:'OTHER-'+suffix})];
// The deliberate duplicate existing plate is tested separately, so the normal
// import can establish one unique binding first.
const clean=rows.slice(0,4),agencies=[{external_id:id('agency'),code:'CODE-'+suffix,name,provider_updated_at:'2020-01-01T00:00:00Z'}];
const sync=vs=>`public.fleet_sync_inventory(${json(vs)},${json(agencies)},now())`;
const contract=(n,vehicleId,clientCode,extra={})=>({external_id:id('contract-'+n),num:id('CON-'+n),client_code:clientCode,name:'Synthetic driver '+n,plate:vehicleId==='existing'?plate:plate+'-'+vehicleId,temporary_plate:'',model:'Synthetic Test',status:'IN_PROGRESS',start_at:'2020-01-01T00:00:00Z',effective_start_at:'2020-01-01T00:00:00Z',end_at:null,provider_updated_at:'2020-01-01T00:00:00Z',deleted:false,details_verified:true,vehicle_external_id:id(vehicleId),departure_agency_external_id:id('agency'),return_agency_external_id:null,...extra});
const contracts=[contract('known','existing',code),contract('new','rented',id('new-code')),contract('notstarted','unused',id('future-code'),{effective_start_at:null})];
let checks=0;const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'inventory-test: ${label}';end if;end $test$;`;};
const deny=(statement,label,error='insufficient_privilege')=>{checks++;return `do $test$ declare denied boolean:=false;begin begin ${statement};exception when ${error} then denied:=true;end;if not denied then raise exception 'inventory-test: ${label}';end if;end $test$;`;};
const perform=expr=>`do $work$ begin perform ${expr};end $work$;`;
const auth=user=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(user)};set local request.jwt.claims=${q(JSON.stringify({sub:user,role:'authenticated'}))};`;
const service="reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';set local role service_role;";
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(args.length?[check("to_regclass('public.fleet_myclicar_vehicles') is null",'migration_not_applied'),readFileSync(new URL('../supabase/migrations/20261207000000_full_inventory.sql',import.meta.url),'utf8')]:[]),
 check("to_regclass('public.fleet_myclicar_vehicles') is not null",'migration_exists'),perform("pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0))"),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},${q(name)},'Casablanca');`,
 `insert into public.vehicles(key,plate,vin,model,agency_id,geotab_id,ref_l100,active) values(${q(key)},${q(plate)},${q('VIN-'+suffix)},'Preserved local model',${agency},'SYNTHETIC-GEOTAB',6.7,'OUI');`,
 `insert into public.drivers(code,name,agency_id,source,phone,note) values(${q(code)},'Preserved manual driver',${agency},'manuel','0000000000','Preserved note');`,
 `insert into auth.users(id,email,aud,role) values(${q(manager)},${q('inventory-manager-'+suffix+'@example.invalid')},'authenticated','authenticated'),(${q(admin)},${q('inventory-admin-'+suffix+'@example.invalid')},'authenticated','authenticated');`,
 `update public.profiles set role='manager' where user_id=${q(manager)};update public.profiles set role='admin' where user_id=${q(admin)};insert into public.user_agencies(user_id,agency_id) values(${q(manager)},${agency});`,service,
 check(`(${sync(clean)}->>'current_vehicles')::int=3`,'complete_inventory_count'),
 check(`(select count(*) from public.vehicles where myclicar_external_id in(${clean.map(v=>q(v.external_id)).join(',')}))=3`,'unused_vehicle_imported_archived_excluded'),
 check(`(select vehicle_key=${q(key)} from public.fleet_myclicar_vehicles where external_id=${q(id('existing'))})`,'exact_existing_vehicle'),
 check(`(select geotab_id='SYNTHETIC-GEOTAB' and model='Preserved local model' and ref_l100=6.7 and agency_id=${agency} from public.vehicles where key=${q(key)})`,'manual_vehicle_settings_preserved'),
 check(`(select active='OUI' and geotab_id is null and agency_id is null and not geotab_auto_link_disabled from public.vehicles where myclicar_external_id=${q(id('unused'))})`,'unused_has_no_invented_gps_or_agency_and_allows_exact_autolink'),
 check(`(select agency_id=${agency} from public.fleet_myclicar_agencies where external_id=${q(id('agency'))})`,'exact_agency_reused'),
 `update public.vehicles set geotab_auto_link_disabled=true where myclicar_external_id=${q(id('unused'))};`,
 check(`(${sync(clean)}->>'matched_vehicles')::int=3`,'repeat_idempotent'),
 check(`(select geotab_auto_link_disabled from public.vehicles where myclicar_external_id=${q(id('unused'))})`,'inventory_preserves_manual_dissociation'),
 check(`(public.fleet_sync_myclicar(${json(contracts)},now())->>'matched_assignments')::int=2`,'verified_departures_assign'),
 check(`(select source='myclicar' and agency_id=${agency} and phone is null and email is null from public.drivers where code=${q(id('new-code'))})`,'minimal_driver_reference_created'),
 check(`not exists(select 1 from public.drivers where code=${q(id('future-code'))})`,'unconfirmed_departure_cannot_create_driver'),
 check(`(select name='Preserved manual driver' and phone='0000000000' and note='Preserved note' and source='manuel' from public.drivers where code=${q(code)})`,'manual_driver_preserved'),
 check(`(select agency_id=${agency} and geotab_id is null from public.vehicles where myclicar_external_id=${q(id('rented'))})`,'verified_departure_agency_fills_missing'),
 check(`(select details_verified and agency_id=${agency} and eligible from public.fleet_myclicar_contracts where external_id=${q(id('contract-new'))})`,'contract_scope_and_proof'),
 check(`exists(select 1 from public.contracts where num=${q(id('CON-new'))})`,'new_contract_visible_in_ludy'),
 perform(sync(rows)),
 check(`(select count(*) from public.fleet_myclicar_vehicles where external_id in(${[id('duplicate1'),id('duplicate2'),id('existing'),id('conflict')].map(q).join(',')}) and vehicle_key is null and reason='ambiguous_vehicle')=4`,'duplicate_catalog_references_unresolved'),
 check(`(select geotab_id='SYNTHETIC-GEOTAB' and agency_id=${agency} from public.vehicles where key=${q(key)})`,'ambiguous_snapshot_keeps_manual_local_settings'),
 deny(`perform public.fleet_sync_inventory(${json([clean[0],clean[0]])},${json(agencies)},now())`,'duplicate_snapshot_rejected','raise_exception'),
 deny(`perform public.fleet_sync_inventory(${json(clean)},${json(agencies)},now()-interval '301 seconds')`,'stale_snapshot_rejected','raise_exception'),
 auth(manager),check(`(select count(*) from public.fleet_myclicar_vehicles where external_id in(${clean.map(v=>q(v.external_id)).join(',')}))=1`,'manager_inventory_is_scoped'),
 check(`not exists(select 1 from public.fleet_inventory_sync)`,'manager_cannot_read_global_totals'),
 check(`(select count(*) from public.fleet_myclicar_contracts where external_id in(${contracts.map(c=>q(c.external_id)).join(',')}))=3`,'manager_contracts_scoped'),
 deny(`perform ${sync(clean)}`,'manager_cannot_sync'),auth(admin),deny(`perform ${sync(clean)}`,'browser_admin_cannot_sync'),
 'reset role;set local role anon;',deny('perform 1 from public.fleet_myclicar_vehicles limit 1','anonymous_inventory_denied'),
 service,check("not has_function_privilege('service_role','public.fleet_sync_myclicar_reference_base(jsonb,timestamptz)','EXECUTE')",'base_not_exposed'),
 'rollback;'].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const localArgs=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(arg=>arg==='--username=postgres'?'--username=supabase_admin':arg);
const executed=spawnSync('docker',localArgs,{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
if(executed.error||executed.status!==0){const label=String(executed.stderr||'').match(/inventory-test: ([a-zA-Z_]+)/)?.[1],state=String(executed.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Local inventory validation failed; transaction rolled back. '+(label||state||'No database output disclosed.'));}
assert.equal(executed.stdout.trim(),'');console.log(JSON.stringify({ok:true,checks,rolledBack:true,migrationInTransaction:!!args.length}));
