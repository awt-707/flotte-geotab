// Local-only synthetic shifts. All fixture rows and optional migration roll back.
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {assertLocalProject} from '../scripts/guard.mjs';
assertLocalProject();
const args=process.argv.slice(2);if(args.length>1||args.some(x=>x!=='--with-migration'))throw Error('Only --with-migration is supported.');
const withMigration=args.includes('--with-migration'),suffix=randomUUID(),q=v=>"'"+String(v).replaceAll("'","''")+"'",json=v=>q(JSON.stringify(v))+'::jsonb';
const ids=Object.fromEntries(['owner','other','ownerUber','ownerBolt','otherUber'].map(x=>[x,randomUUID()]));
const code=x=>'CONTRACT_RETURN_CODE_'+x+'_'+suffix,car=x=>'CONTRACT_RETURN_CAR_'+x+'_'+suffix,plate=x=>'CONTRACT-RETURN-'+x+'-'+suffix;
const contract='CONTRACT_RETURN_'+suffix,second=contract+'_SECOND',agency=Date.now()*1000+randomInt(900),fixtures=[q(ids.owner),q(ids.other)].join(',');let checks=0;
const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'contract-return-test: ${label}'; end if; end $test$;`;};
const denied=(statement,label)=>{checks++;return `do $test$ declare refused boolean:=false; begin begin ${statement}; exception when insufficient_privilege then refused:=true; end; if not refused then raise exception 'contract-return-test: ${label}'; end if; end $test$;`;};
const perform=exp=>`do $work$ begin perform ${exp}; end $work$;`;
const fresh="update public.fleet_sources set status='healthy',last_success_at=now(),stale_after_s=case id when 'uber' then 45 when 'bolt' then 150 else 300 end where id in('uber','bolt','myclicar');";
const reset=`delete from public.fleet_contract_assignment_overrides where contract_id in(${q(contract)},${q(second)});
 delete from public.fleet_myclicar_contracts where external_id=${q(second)};
 delete from public.fleet_latest where driver_id in(${fixtures});
 delete from public.fleet_link_audit where driver_id in(${fixtures});
 update public.fleet_drivers set vehicle_key=null,vehicle_link_method=null,vehicle_link_evidence='{}',auto_link_disabled=false,agency_id=${agency},link_method='manual' where id in(${fixtures});
 update public.drivers set agency_id=${agency} where code in(${q(code('owner'))},${q(code('other'))});
 update public.vehicles set active='OUI',other_plates='',agency_id=${agency} where key in(${q(car('one'))},${q(car('two'))});
 update public.fleet_myclicar_contracts set current=true,eligible=true,observed_at=now(),status='IN_PROGRESS',end_at=null,deleted=false,effective_start_at=now()-interval '1 day' where external_id=${q(contract)};
 ${fresh}`;
const observe=(who='owner',source='uber',vehicle='one',options={})=>{
 const identity=ids[who+(source==='uber'?'Uber':'Bolt')],evidence={method:source==='uber'?'visible_dom':'official_api',...(source==='bolt'?{vehicle_origin:'bolt_live'}:{}),...options.evidence};
 return `insert into public.fleet_latest(identity_id,driver_id,source,status,observed_at,received_at,vehicle_label,evidence) values
 (${q(identity)},${q(ids[who])},${q(source)},${q(options.status||'on_trip')},${options.at||"now()-interval '10 seconds'"},now(),${q(options.label||plate(vehicle))},${json(evidence)})
 on conflict(identity_id) do update set status=excluded.status,observed_at=excluded.observed_at,received_at=excluded.received_at,vehicle_label=excluded.vehicle_label,evidence=excluded.evidence;`;
};
const reconcile='public.fleet_reconcile_vehicle_contracts()',override=`exists(select 1 from public.fleet_contract_assignment_overrides where contract_id=${q(contract)})`;
const held=`(select vehicle_key=${q(car('one'))} from public.fleet_drivers where id=${q(ids.owner)})`;
const contractLink=`public.fleet_auto_link_myclicar_vehicle(${q(ids.owner)},${q(contract)})`;
// Simulate the already-recorded contradiction twenty seconds before the return.
// SQL now() is transaction-stable, so advance this fixture's clock explicitly.
const recordPast=`update public.fleet_contract_assignment_overrides set latest_conflict_at=observed_at where contract_id=${q(contract)};`;
const prepare=[reset,observe('other','uber','one',{at:"now()-interval '20 seconds'"}),perform(reconcile),check(override,'known_other_driver_suspends'),recordPast,observe('other','uber','one',{status:'offline'})];
const duplicate=(person='other',vehicle='one')=>`insert into public.fleet_myclicar_contracts(external_id,num,client_code,plate,status,start_at,effective_start_at,vehicle_key,vehicle_candidates,current,eligible,observed_at)
 values(${q(second)},${q(second)},${q(code(person))},${q(plate(vehicle))},'IN_PROGRESS',now()-interval '2 hours',now()-interval '2 hours',${q(car(vehicle))},array[${q(car(vehicle))}],true,true,now());`;
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(withMigration?[readFileSync(new URL('../supabase/migrations/20261219000000_confirmed_contract_return.sql',import.meta.url),'utf8')]:[]),
 check("to_regprocedure('public.fleet_reconcile_vehicle_contracts_identity_base()') is not null",'migration_available'),perform("pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0))"),
 `insert into public.agencies(id,name) overriding system value values(${agency},'Synthetic contract return'),(${agency+1},'Synthetic separate agency');
 insert into public.vehicles(key,plate,active,agency_id) values(${q(car('one'))},${q(plate('one'))},'OUI',${agency}),(${q(car('two'))},${q(plate('two'))},'OUI',${agency});
 insert into public.drivers(code,name,agency_id) values(${q(code('owner'))},'Synthetic Contract Holder',${agency}),(${q(code('other'))},'Synthetic Other Driver',${agency});
 insert into public.fleet_drivers(id,name,ludy_driver_code,agency_id,link_method) values(${q(ids.owner)},'Synthetic Contract Holder',${q(code('owner'))},${agency},'manual'),(${q(ids.other)},'Synthetic Other Driver',${q(code('other'))},${agency},'exact_name');
 insert into public.fleet_identities(id,driver_id,source,source_key) values(${q(ids.ownerUber)},${q(ids.owner)},'uber',${q('ownerUber'+suffix)}),(${q(ids.ownerBolt)},${q(ids.owner)},'bolt',${q('ownerBolt'+suffix)}),(${q(ids.otherUber)},${q(ids.other)},'uber',${q('otherUber'+suffix)});
 insert into public.fleet_myclicar_contracts(external_id,num,client_code,plate,status,start_at,effective_start_at,vehicle_key,vehicle_candidates,current,eligible,observed_at)
 values(${q(contract)},${q(contract)},${q(code('owner'))},${q(plate('one'))},'IN_PROGRESS',now()-interval '1 day',now()-interval '1 day',${q(car('one'))},array[${q(car('one'))}],true,true,now());
 insert into public.contracts(num,client_code,vehicle_key,status,start_at) values(${q(contract)},${q(code('owner'))},${q(car('one'))},'IN_PROGRESS',now()-interval '1 day');
 set local role service_role;`,
 ...prepare,perform(reconcile),check(override,'offline_other_alone_cannot_restore'),check(`not ${contractLink}`,'fallback_blocked_without_return_proof'),
 observe(),check(`(${reconcile}->>'contract_returns_confirmed')::integer>=1`,'later_owner_plate_lifts'),check(`not ${override}`,'return_clears_barrier'),
 check(`exists(select 1 from public.fleet_link_audit where driver_id=${q(ids.owner)} and action='contract_return_confirmed' and method='platform_return'
  and evidence->>'contract_id'=${q(contract)} and evidence->'previous_evidence'->>'client_code'=${q(code('other'))}
  and (evidence->>'observed_at')::timestamptz>(evidence->>'previous_observed_at')::timestamptz)`,'return_and_previous_contradiction_audited'),
 check(`(${reconcile}->>'contract_returns_confirmed')::integer=0`,'return_idempotent'),
 observe('owner','uber','one',{at:"now()-interval '1 hour'"}),perform(reconcile),check(`not ${override}`,'confirmed_return_survives_observation_expiry'),check(contractLink,'current_contract_fallback_restored'),check(held,'correct_holder_assigned'),
 check(`(select client_code=${q(code('owner'))} and vehicle_key=${q(car('one'))} and status='IN_PROGRESS' and end_at is null from public.contracts where num=${q(contract)})`,'commercial_contract_unchanged'),
 observe('other','uber','one',{at:'now()'}),perform(reconcile),check(override,'new_shift_creates_new_barrier'),check(`not ${contractLink}`,'new_shift_blocks_old_holder_again'),
 reset,observe('owner','uber','two',{at:"now()-interval '20 seconds'"}),perform(reconcile),check(override,'own_other_vehicle_suspends'),recordPast,observe(),perform(reconcile),check(`not ${override}`,'later_owner_returns_to_contract_vehicle'),
 ...prepare,observe('owner','bolt'),perform(reconcile),check(`not ${override}`,'live_bolt_return_supported'),
 ...prepare,observe('owner','uber','one',{at:"now()-interval '15 seconds'"}),observe('other','uber','one',{at:"now()-interval '5 seconds'"}),perform(reconcile),
 check(`(select observed_at=now()-interval '20 seconds' and latest_conflict_at=now()-interval '5 seconds' from public.fleet_contract_assignment_overrides where contract_id=${q(contract)})`,'latest_contradiction_preserved_separately'),
 observe('other','uber','one',{status:'offline'}),perform(reconcile),check(override,'older_owner_proof_cannot_overrule_later_offline_shift'),
 observe('owner','uber','one',{at:'now()'}),perform(reconcile),check(`not ${override}`,'newer_owner_proof_resolves_latest_shift'),
 ...[
  ['same_timestamp',observe('owner','uber','one',{at:"now()-interval '20 seconds'"})],
  ['older_owner_proof',observe('owner','uber','one',{at:"now()-interval '21 seconds'"})],
  ['migration_cutover',`update public.fleet_contract_assignment_overrides set latest_conflict_at=now() where contract_id=${q(contract)};`],
  ['stale_observation',observe('owner','uber','one',{at:"now()-interval '1 hour'"})],
  ['offline_owner',observe('owner','uber','one',{status:'offline'})],
  ['unknown_owner',observe('owner','uber','one',{status:'unknown'})],
  ['selected_bolt',`delete from public.fleet_latest where identity_id=${q(ids.ownerUber)};`+observe('owner','bolt','one',{evidence:{vehicle_origin:'bolt_selected'}})],
  ['paused_platform',"update public.fleet_sources set status='paused' where id='uber';"],
  ['stale_platform',"update public.fleet_sources set last_success_at=now()-interval '1 hour' where id='uber';"],
  ['paused_contract_source',"update public.fleet_sources set status='paused' where id='myclicar';"],
  ['stale_contract_source',"update public.fleet_sources set last_success_at=now()-interval '1 hour' where id='myclicar';"],
  ['stale_contract',`update public.fleet_myclicar_contracts set observed_at=now()-interval '1 hour' where external_id=${q(contract)};`],
  ['closed_contract',`update public.fleet_myclicar_contracts set status='FINISHED',end_at=now() where external_id=${q(contract)};`],
  ['deleted_contract',`update public.fleet_myclicar_contracts set deleted=true where external_id=${q(contract)};`],
  ['ineligible_contract',`update public.fleet_myclicar_contracts set eligible=false where external_id=${q(contract)};`],
  ['not_current_contract',`update public.fleet_myclicar_contracts set current=false where external_id=${q(contract)};`],
  ['future_departure',`update public.fleet_myclicar_contracts set effective_start_at=now()+interval '1 hour' where external_id=${q(contract)};`],
  ['unconfirmed_identity',`update public.fleet_drivers set link_method=null where id=${q(ids.owner)};`],
  ['manual_vehicle_mode',`update public.fleet_drivers set auto_link_disabled=true,vehicle_link_method='manual' where id=${q(ids.owner)};`],
  ['legacy_manual_vehicle',`update public.fleet_drivers set vehicle_key=${q(car('one'))},vehicle_link_method=null where id=${q(ids.owner)};`],
  ['manual_other_holder',`update public.fleet_drivers set vehicle_key=${q(car('one'))},vehicle_link_method='manual',auto_link_disabled=true where id=${q(ids.other)};`],
  ['cross_agency_reference',`update public.drivers set agency_id=${agency+1} where code=${q(code('owner'))};`],
  ['cross_agency_profile',`update public.fleet_drivers set agency_id=${agency+1} where id=${q(ids.owner)};`],
  ['inactive_vehicle',`update public.vehicles set active='NON' where key=${q(car('one'))};`],
  ['different_live_car',observe('owner','uber','two')],
  ['competing_live_driver',observe('other')],
  ['contradictory_second_platform',observe('owner','bolt','two')],
  ['unknown_second_plate',observe('owner','bolt','one',{label:'UNRECOGNIZED-'+suffix})],
  ['ambiguous_plate',`update public.vehicles set other_plates=${q(plate('one'))} where key=${q(car('two'))};`],
  ['same_vehicle_second_contract',duplicate()],
  ['same_person_second_contract',duplicate('owner','two')]
 ].flatMap(([name,change])=>[...prepare,observe(),change,perform(reconcile),check(override,name+'_cannot_lift')]),
 denied('perform public.fleet_reconcile_vehicle_contracts_identity_base()','service_cannot_bypass_return_wrapper'),
 'reset role;set local role authenticated;',denied(`perform ${reconcile}`,'authenticated_cannot_reconcile'),
 'reset role;set local role anon;',denied(`perform ${reconcile}`,'anon_cannot_reconcile'),
 'reset role;rollback;',"select 'CONFIRMED_CONTRACT_RETURN_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const localArgs=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x);
const result=spawnSync('docker',localArgs,{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
if(result.error||result.status!==0){
 const label=String(result.stderr||'').match(/contract-return-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];
 throw Error('Local contract return validation failed; transaction rolled back.'+(label?' Check: '+label:state?' SQLSTATE: '+state:' No database output disclosed.'));
}
assert.equal(result.stdout.trim(),'CONFIRMED_CONTRACT_RETURN_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:withMigration,rolled_back:true}));
