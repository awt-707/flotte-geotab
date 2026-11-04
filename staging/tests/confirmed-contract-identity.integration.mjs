// Local SQL only. The migration and every synthetic observation are rolled back.
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {assertLocalProject} from '../scripts/guard.mjs';
assertLocalProject();
const args=process.argv.slice(2);if(args.length>1||args.some(x=>x!=='--with-migration'))throw new Error('Only --with-migration is supported.');
const withMigration=args.includes('--with-migration'),suffix=randomUUID(),q=v=>"'"+String(v).replaceAll("'","''")+"'";
const ids=Object.fromEntries(['owner','other','oldProfile','uber','bolt','otherUber'].map(x=>[x,randomUUID()]));
const code=x=>'CONFIRMED_IDENTITY_'+x+'_'+suffix,car=x=>'CONFIRMED_CAR_'+x+'_'+suffix,plate=x=>'CONFIRMED-'+x+'-'+suffix;
const contract='CONFIRMED_CONTRACT_'+suffix,agency=Date.now()*1000+randomInt(900),json=v=>q(JSON.stringify(v))+'::jsonb';let checks=0;
const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'confirmed-identity-test: ${label}'; end if; end $test$;`;};
const denied=(statement,label)=>{checks++;return `do $test$ declare refused boolean:=false; begin begin ${statement}; exception when insufficient_privilege then refused:=true; end; if not refused then raise exception 'confirmed-identity-test: ${label}'; end if; end $test$;`;};
const perform=exp=>`do $work$ begin perform ${exp}; end $work$;`;
const fresh="update public.fleet_sources set status='healthy',last_success_at=now(),stale_after_s=case id when 'uber' then 45 when 'bolt' then 150 else 300 end where id in('uber','bolt','myclicar');";
const fixtureIDs=[q(ids.owner),q(ids.other)].join(',');
const reset=`delete from public.fleet_contract_assignment_overrides where contract_id=${q(contract)};
 delete from public.fleet_latest where driver_id in(${fixtureIDs});
 delete from public.fleet_link_audit where driver_id in(${fixtureIDs});
 update public.fleet_drivers set ludy_driver_code=null,link_method=null,vehicle_key=null,vehicle_link_method=null,vehicle_link_evidence='{}',auto_link_disabled=false where id=${q(ids.owner)};
 update public.fleet_myclicar_contracts set current=true,eligible=true,observed_at=now(),status='IN_PROGRESS',end_at=null where external_id=${q(contract)};
 ${fresh}`;
const observe=(who='owner',source='uber',vehicle='one',options={})=>{
 const identity=who==='other'?ids.otherUber:ids[source],evidence={method:source==='uber'?'visible_dom':'official_api',...(source==='bolt'?{vehicle_origin:'bolt_live'}:{})};
 return `insert into public.fleet_latest(identity_id,driver_id,source,status,observed_at,received_at,vehicle_label,evidence) values
 (${q(identity)},${q(ids[who])},${q(source)},${q(options.status||'on_trip')},${options.at||'now()'},now(),${q(plate(vehicle))},${json(evidence)})
 on conflict(identity_id) do update set status=excluded.status,observed_at=excluded.observed_at,received_at=excluded.received_at,vehicle_label=excluded.vehicle_label,evidence=excluded.evidence;`;
};
const reconcile='public.fleet_reconcile_vehicle_contracts()',override=`exists(select 1 from public.fleet_contract_assignment_overrides where contract_id=${q(contract)})`;
const confirm=`update public.fleet_drivers set ludy_driver_code=${q(code('owner'))},link_method='manual' where id=${q(ids.owner)};`;
const liftedAudit=`exists(select 1 from public.fleet_link_audit where driver_id=${q(ids.owner)} and action='contract_identity_confirmed' and method='confirmed_identity' and evidence->>'contract_id'=${q(contract)} and evidence->'previous_evidence'->>'driver_id'=${q(ids.owner)} and jsonb_typeof(evidence->'previous_evidence'->'client_code')='null')`;
const prepare=[reset,observe(),perform(reconcile),check(override,'unknown_identity_suspends_contract')];
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(withMigration?[readFileSync(new URL('../supabase/migrations/20261216000000_confirmed_contract_identity.sql',import.meta.url),'utf8')]:[]),
 check("to_regprocedure('public.fleet_reconcile_vehicle_contracts_shift_base()') is not null",'migration_available'),perform("pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0))"),
 `insert into public.agencies(id,name) overriding system value values(${agency},'Synthetic confirmed identity');
 insert into public.vehicles(key,plate,active,agency_id) values(${q(car('one'))},${q(plate('one'))},'OUI',${agency}),(${q(car('two'))},${q(plate('two'))},'OUI',${agency});
 insert into public.drivers(code,name,agency_id) values(${q(code('owner'))},'Synthetic Contract Holder',${agency}),(${q(code('other'))},'Synthetic Other Driver',${agency});
 insert into public.fleet_drivers(id,name,ludy_driver_code,agency_id,link_method) values(${q(ids.owner)},'Synthetic Holder Typo',null,${agency},null),(${q(ids.other)},'Synthetic Other Driver',${q(code('other'))},${agency},'exact_name');
 insert into public.fleet_identities(id,driver_id,source,source_key) values(${q(ids.uber)},${q(ids.owner)},'uber',${q('uber'+suffix)}),(${q(ids.bolt)},${q(ids.owner)},'bolt',${q('bolt'+suffix)}),(${q(ids.otherUber)},${q(ids.other)},'uber',${q('other'+suffix)});
 insert into public.fleet_myclicar_contracts(external_id,num,client_code,plate,status,start_at,effective_start_at,vehicle_key,vehicle_candidates,current,eligible,observed_at)
 values(${q(contract)},${q(contract)},${q(code('owner'))},${q(plate('one'))},'IN_PROGRESS',now()-interval '1 day',now()-interval '1 day',${q(car('one'))},array[${q(car('one'))}],true,true,now());
 insert into public.contracts(num,client_code,vehicle_key,status,start_at) values(${q(contract)},${q(code('owner'))},${q(car('one'))},'IN_PROGRESS',now()-interval '1 day');
 set local role service_role;`,
 ...prepare,perform(reconcile),check(override,'repeated_unknown_claim_never_lifts'),confirm,
 check(`(${reconcile}->>'identity_contradictions_cleared')::integer>=1`,'confirmed_identity_lifts'),check(`not ${override}`,'resolved_contradiction_removed'),check(liftedAudit,'original_contradiction_audited'),
 check(`(select client_code=${q(code('owner'))} and vehicle_key=${q(car('one'))} and status='IN_PROGRESS' and end_at is null from public.contracts where num=${q(contract)})`,'commercial_contract_unchanged'),
 check(`public.fleet_auto_link_myclicar_vehicle(${q(ids.owner)},${q(contract)})`,'confirmed_contract_can_assign_automatically'),
 check(`(${reconcile}->>'identity_contradictions_cleared')::integer=0`,'confirmation_idempotent'),
 ...['exact_name','name_spacing'].flatMap(method=>[...prepare,confirm,`update public.fleet_drivers set link_method=${q(method)} where id=${q(ids.owner)};`,perform(reconcile),check(`not ${override}`,method+'_confirmation_lifts')]),
 ...prepare,confirm,`update public.fleet_contract_assignment_overrides set evidence=jsonb_set(evidence,'{driver_id}',to_jsonb(${q(ids.oldProfile)}::text)) where contract_id=${q(contract)};`,perform(reconcile),check(override,'different_original_profile_stays_blocked'),
 `insert into public.fleet_link_audit(driver_id,action,method,evidence) values(${q(ids.owner)},'associate','exact_name',${json({previous_driver_id:ids.oldProfile,ludy_driver_code:code('owner')})});`,perform(reconcile),check(`not ${override}`,'proven_canonical_merge_lifts'),
 ...[
  ['paused_platform',"update public.fleet_sources set status='paused' where id='uber';"],
  ['stale_platform',"update public.fleet_sources set last_success_at=now()-interval '1 hour' where id='uber';"],
  ['paused_contract_source',"update public.fleet_sources set status='paused' where id='myclicar';"],
  ['stale_contract_source',"update public.fleet_sources set last_success_at=now()-interval '1 hour' where id='myclicar';"],
  ['stale_contract',`update public.fleet_myclicar_contracts set observed_at=now()-interval '1 hour' where external_id=${q(contract)};`],
  ['unconfirmed_identity',`update public.fleet_drivers set link_method=null where id=${q(ids.owner)};`],
  ['closed_contract',`update public.fleet_myclicar_contracts set status='FINISHED',end_at=now() where external_id=${q(contract)};`],
  ['ineligible_contract',`update public.fleet_myclicar_contracts set eligible=false where external_id=${q(contract)};`],
  ['not_current_contract',`update public.fleet_myclicar_contracts set current=false where external_id=${q(contract)};`],
  ['different_live_car',observe('owner','uber','two')],
  ['competing_live_driver',observe('other')],
  ['contradictory_second_platform',observe('owner','bolt','two')],
  ['stale_observation',observe('owner','uber','one',{at:"now()-interval '1 hour'"})],
  ['offline_observation',observe('owner','uber','one',{status:'offline'})],
  ['known_previous_holder',`update public.fleet_contract_assignment_overrides set evidence=jsonb_set(evidence,'{client_code}',to_jsonb(${q(code('other'))}::text)) where contract_id=${q(contract)};`]
 ].flatMap(([name,change])=>[...prepare,confirm,change,perform(reconcile),check(override,name+'_cannot_lift')]),
 reset,observe('owner','bolt'),perform(reconcile),check(override,'unknown_bolt_suspends'),confirm,perform(reconcile),check(`not ${override}`,'bolt_confirmation_lifts'),
 denied('perform public.fleet_reconcile_vehicle_contracts_shift_base()','service_cannot_bypass_wrapper'),
 'reset role;set local role authenticated;',denied(`perform ${reconcile}`,'authenticated_cannot_reconcile'),
 'reset role;set local role anon;',denied(`perform ${reconcile}`,'anon_cannot_reconcile'),
 'reset role;rollback;',"select 'CONFIRMED_CONTRACT_IDENTITY_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const localArgs=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x);
const result=spawnSync('docker',localArgs,{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
if(result.error||result.status!==0){
 const label=String(result.stderr||'').match(/confirmed-identity-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];
 throw new Error('Local confirmed identity validation failed; transaction rolled back.'+(label?' Check: '+label:state?' SQLSTATE: '+state:' No database output disclosed.'));
}
assert.equal(result.stdout.trim(),'CONFIRMED_CONTRACT_IDENTITY_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:withMigration,rolled_back:true}));
