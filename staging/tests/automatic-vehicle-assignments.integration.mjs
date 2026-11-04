// Pinned local SQL only. Migration, observations and assertions all roll back.
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {assertLocalProject} from '../scripts/guard.mjs';
assertLocalProject();
const args=process.argv.slice(2);if(args.length>1||args.some(x=>x!=='--with-migration'))throw new Error('Only --with-migration is supported.');
const withMigration=args.includes('--with-migration'),suffix=randomUUID(),q=v=>"'"+String(v).replaceAll("'","''")+"'";
const ids=Object.fromEntries(['a','b','unknown','aUber','aBolt','bUber','unknownUber','admin','manager','viewer'].map(x=>[x,randomUUID()]));
const code=x=>'AUTO_SHIFT_CODE_'+x+'_'+suffix,car=x=>'AUTO_SHIFT_CAR_'+x+'_'+suffix,plate=x=>'AUTO-SHIFT-'+x+'-'+suffix;
const contract='AUTO_SHIFT_CONTRACT_'+suffix,agency=Date.now()*1000+randomInt(900),fixtureIDs=['a','b','unknown'].map(x=>q(ids[x])).join(',');
const json=v=>q(JSON.stringify(v))+'::jsonb';let checks=0;
const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'auto-shift-test: ${label}'; end if; end $test$;`;};
const denied=(statement,label)=>{checks++;return `do $test$ declare refused boolean:=false; begin begin ${statement}; exception when insufficient_privilege then refused:=true; end; if not refused then raise exception 'auto-shift-test: ${label}'; end if; end $test$;`;};
const perform=exp=>`do $work$ begin perform ${exp}; end $work$;`;
const service="reset role; set local request.jwt.claim.sub=''; set local request.jwt.claims='{}'; set local role service_role;";
const auth=x=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(ids[x])};set local request.jwt.claims=${json({sub:ids[x],role:'authenticated'}).replace(/::jsonb$/,'')};`;
const fresh="update public.fleet_sources set status='healthy',last_success_at=now(),stale_after_s=case id when 'uber' then 45 when 'bolt' then 150 else 300 end where id in('uber','bolt','myclicar');";
const reset=`delete from public.fleet_contract_assignment_overrides where contract_id=${q(contract)};
 delete from public.fleet_latest where driver_id in(${fixtureIDs});
 update public.fleet_drivers set vehicle_key=null,vehicle_link_method=null,vehicle_link_evidence='{}',auto_link_disabled=false where id in(${fixtureIDs});
 update public.fleet_myclicar_contracts set client_code=${q(code('a'))},vehicle_key=${q(car('one'))},vehicle_candidates=array[${q(car('one'))}],effective_start_at=now()-interval '1 day',observed_at=now(),current=true,eligible=true where external_id=${q(contract)};
 ${fresh}`;
const observe=(driver,source='uber',vehicle='one',options={})=>{
 const identity=ids[driver+(source==='uber'?'Uber':'Bolt')],evidence={method:source==='uber'?'visible_dom':'official_api',...(source==='bolt'?{vehicle_origin:'bolt_live'}:{}),...options.evidence};
 return `insert into public.fleet_latest(identity_id,driver_id,source,status,observed_at,received_at,vehicle_label,evidence) values
 (${q(identity)},${q(ids[driver])},${q(source)},${q(options.status||'on_trip')},${options.at||'now()'},now(),${options.label===null?'null':q(options.label||plate(vehicle))},${json(evidence)}${options.vehicleAt?`||jsonb_build_object('vehicle_observed_at',${options.vehicleAt})`:''})
 on conflict(identity_id) do update set status=excluded.status,observed_at=excluded.observed_at,received_at=excluded.received_at,vehicle_label=excluded.vehicle_label,evidence=excluded.evidence;`;
};
const proof=(source='uber',at='now()',extra='')=>`jsonb_build_object('method','platform_plate','source',${q(source)},'vehicle_origin',${q(source==='bolt'?'bolt_live':'uber_visible')},'observed_at',${at},'expires_at',${at}+interval '${source==='bolt'?150:at==='now()'?45:180} seconds')${extra}`;
const liveLink=(driver,vehicle='one',evidence=proof())=>`public.fleet_auto_link_vehicle(${q(ids[driver])},${q(car(vehicle))},${evidence})`;
const contractLink=(driver='a')=>`public.fleet_auto_link_myclicar_vehicle(${q(ids[driver])},${q(contract)})`;
const reconcile='public.fleet_reconcile_vehicle_contracts()';
const override=`exists(select 1 from public.fleet_contract_assignment_overrides where contract_id=${q(contract)})`;
const held=(driver,vehicle)=>`(select vehicle_key ${vehicle?'='+q(car(vehicle)):'is null'} from public.fleet_drivers where id=${q(ids[driver])})`;
const onlyReset=`update public.fleet_drivers set vehicle_key=null,vehicle_link_evidence='{}' where id in(${fixtureIDs});`;
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(withMigration?[readFileSync(new URL('../supabase/migrations/20261127000000_automatic_vehicle_assignments.sql',import.meta.url),'utf8')]:[]),
 check("to_regclass('public.fleet_contract_assignment_overrides') is not null",'migration_available'),perform("pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0))"),
 `insert into public.agencies(id,name) overriding system value values(${agency},'Synthetic shift agency'),(${agency+1},'Synthetic other agency');
 insert into public.vehicles(key,plate,other_plates,active,agency_id) values
 (${q(car('one'))},${q(plate('one'))},${q(plate('old'))},'OUI',${agency}),(${q(car('two'))},${q(plate('two'))},'','OUI',${agency}),(${q(car('cross'))},${q(plate('cross'))},'','OUI',${agency+1});
 insert into public.drivers(code,name,agency_id) values(${q(code('a'))},'Synthetic Shift Alpha',${agency}),(${q(code('b'))},'Synthetic Shift Bravo',${agency});
 insert into public.fleet_drivers(id,name,ludy_driver_code,agency_id,link_method) values
 (${q(ids.a)},'Synthetic Shift Alpha',${q(code('a'))},${agency},'manual'),(${q(ids.b)},'Synthetic Shift Bravo',${q(code('b'))},${agency},'exact_name'),(${q(ids.unknown)},'Synthetic Unknown Shift',null,${agency},null);
 insert into public.fleet_identities(id,driver_id,source,source_key) values ${[['aUber','a','uber'],['aBolt','a','bolt'],['bUber','b','uber'],['unknownUber','unknown','uber']].map(([id,d,src])=>`(${q(ids[id])},${q(ids[d])},${q(src)},${q(id+suffix)})`).join(',')};
 insert into public.fleet_myclicar_contracts(external_id,num,client_code,plate,status,start_at,effective_start_at,vehicle_key,vehicle_candidates,current,eligible,observed_at)
 values(${q(contract)},${q(contract)},${q(code('a'))},${q(plate('one'))},'IN_PROGRESS',now()-interval '1 day',now()-interval '1 day',${q(car('one'))},array[${q(car('one'))}],true,true,now());
 insert into public.contracts(num,client_code,vehicle_key,status,start_at) values(${q(contract)},${q(code('a'))},${q(car('one'))},'IN_PROGRESS',now()-interval '1 day');
 insert into auth.users(id,email,aud,role) values ${['admin','manager','viewer'].map(x=>`(${q(ids[x])},${q('auto-shift-'+x+'-'+suffix+'@example.invalid')},'authenticated','authenticated')`).join(',')};`,
 ...['admin','manager','viewer'].map(x=>`update public.profiles set role=${q(x)} where user_id=${q(ids[x])};`),service,fresh,
 check(contractLink(),'uncontested_contract_fallback'),
 `insert into public.fleet_motion_checkpoints(identity_id,vehicle_key,source,state,updated_at) values(${q(ids.aUber)},${q(car('one'))},'uber',jsonb_build_object('version',1,'identity_id',${q(ids.aUber)},'vehicle_key',${q(car('one'))},'source','uber'),now());`,
 observe('b','uber','one',{vehicleAt:"now()-interval '120 seconds'",evidence:{vehicle_status:'on_trip',vehicle_model:'Synthetic Model'}}),
 check(`(${reconcile}->>'overrides')::integer>=1`,'shift_creates_override'),check(override,'override_present'),check(held('a',null),'old_contract_lease_revoked'),
 check(`not exists(select 1 from public.fleet_motion_checkpoints where identity_id=${q(ids.aUber)})`,'old_motion_checkpoint_removed'),
 check(liveLink('b','one',proof('uber',"now()-interval '120 seconds'")),'new_live_driver_claims_same_car'),
 check(`(select vehicle_key=${q(car('one'))} and client_code=${q(code('a'))} and status='IN_PROGRESS' and end_at is null from public.contracts where num=${q(contract)})`,'commercial_contract_untouched'),
 observe('b'),perform(reconcile),check(`(select observed_at=now()-interval '120 seconds' from public.fleet_contract_assignment_overrides where contract_id=${q(contract)})`,'identical_override_not_refreshed'),
 observe('b','uber','one',{status:'offline'}),onlyReset,check(`not ${contractLink()}`,'offline_does_not_restore_old_contract'),
 `update public.fleet_myclicar_contracts set observed_at=now(),provider_updated_at=now() where external_id=${q(contract)};`,check(`not ${contractLink()}`,'same_contract_resync_does_not_restore_old_contract'),
 perform(`public.fleet_sync_myclicar((select jsonb_agg(to_jsonb(c)) from public.fleet_myclicar_contracts c where external_id=${q(contract)}),now())`),check(`not ${contractLink()}`,'complete_provider_resync_preserves_override'),
 `update public.fleet_latest set observed_at=now()-interval '1 hour' where driver_id=${q(ids.b)};`,perform(reconcile),check(`not ${contractLink()}`,'expired_live_proof_preserves_override'),
 ...['admin','manager','viewer'].flatMap(x=>[auth(x),check(x==='admin'?override:`not ${override}`,x+'_override_read_scope'),
 denied(`update public.fleet_contract_assignment_overrides set evidence='{}' where contract_id=${q(contract)}`,x+'_cannot_write_override'),
 denied(`perform ${reconcile}`,x+'_cannot_reconcile'),denied(`perform public.fleet_link_driver_automatic(${q(ids.a)},${q(code('a'))},null)`,x+'_cannot_enable_auto'),
 denied(`perform public.fleet_current_vehicle_claims()`,x+'_cannot_use_private_claims')]),
 'reset role;set local role anon;',denied('perform 1 from public.fleet_contract_assignment_overrides','anon_cannot_read'),denied(`perform ${reconcile}`,'anon_cannot_reconcile'),denied(`perform public.fleet_link_driver_automatic(${q(ids.a)},${q(code('a'))},null)`,'anon_cannot_enable_automatic'),
 service,denied('perform public.fleet_current_vehicle_claims()','service_cannot_bypass_private_claims'),
 denied(`perform public.fleet_auto_link_vehicle_platform_base(${q(ids.b)},${q(car('one'))},${proof()})`,'service_cannot_bypass_platform_guard'),
 denied(`perform public.fleet_auto_link_myclicar_vehicle_contract_base(${q(ids.a)},${q(contract)})`,'service_cannot_bypass_contract_guard'),
 `update public.fleet_myclicar_contracts set effective_start_at=now()-interval '2 hours' where external_id=${q(contract)};`,check(contractLink(),'new_departure_fingerprint_allows_fallback'),onlyReset,
 `update public.fleet_myclicar_contracts set effective_start_at=now()-interval '1 day',vehicle_key=${q(car('two'))},vehicle_candidates=array[${q(car('two'))}] where external_id=${q(contract)};`,check(contractLink(),'new_vehicle_fingerprint_allows_fallback'),onlyReset,
 `update public.fleet_myclicar_contracts set vehicle_key=${q(car('one'))},vehicle_candidates=array[${q(car('one'))}],client_code=${q(code('b'))} where external_id=${q(contract)};`,check(contractLink('b'),'new_client_fingerprint_allows_fallback'),
 reset,observe('a','uber','two'),perform(reconcile),check(override,'same_person_different_car_overrides_contract'),check(liveLink('a','two'),'current_plate_wins_over_own_contract'),
 reset,observe('unknown'),check(`not ${contractLink()}`,'unknown_new_profile_blocks_contract_before_reconcile'),perform(reconcile),check(override,'unknown_profile_creates_durable_override'),
 observe('unknown','uber','one',{status:'offline'}),check(`not ${contractLink()}`,'unknown_profile_offline_does_not_restore_contract'),check(`not ${liveLink('unknown')}`,'unknown_profile_never_auto_assigned'),
 reset,observe('a'),observe('b'),perform(reconcile),check(override,'two_live_people_suspend_old_contract'),check(`not ${liveLink('a')} and not ${liveLink('b')}`,'two_live_people_have_no_winner'),
 observe('a','uber','one',{status:'offline'}),observe('b','uber','one',{status:'offline'}),check(`not ${contractLink()}`,'two_live_then_offline_cannot_revive_contract'),
 reset,observe('a'),observe('a','bolt','two'),perform(reconcile),check(override,'two_live_plates_suspend_old_contract'),check(`not ${liveLink('a')} and not ${liveLink('a','two',proof('bolt'))}`,'two_live_plates_have_no_winner'),
 observe('a','uber','one',{status:'offline'}),observe('a','bolt','two',{status:'offline'}),check(`not ${contractLink()}`,'two_plates_then_offline_cannot_revive_contract'),
 reset,observe('b','uber','one',{label:plate('old')}),check(liveLink('b','one',proof('uber','now()',"||jsonb_build_object('expires_at',now()+interval '45 seconds')")),'historical_plate_accepted'),
 reset,`update public.vehicles set other_plates=${q(plate('old'))} where key=${q(car('two'))};`,observe('b','uber','one',{label:plate('old')}),perform(reconcile),check(`not ${override}`,'ambiguous_alias_no_override'),check(`not ${liveLink('b')}`,'ambiguous_alias_no_assignment'),`update public.vehicles set other_plates='' where key=${q(car('two'))};`,
 ...[
  ['stale_status',{at:"now()-interval '46 seconds'"}],['stale_vehicle',{vehicleAt:"now()-interval '180 seconds'"}],['future_vehicle',{vehicleAt:"now()+interval '1 second'"}],['malformed_vehicle',{evidence:{vehicle_observed_at:'bad-date'}}],['offline',{status:'offline'}],['unknown_plate',{label:'UNRECOGNIZED-'+suffix}],['model_only',{label:null,evidence:{vehicle_model:'Synthetic model'}}]
 ].flatMap(([name,opts])=>[reset,observe('b','uber','one',opts),perform(reconcile),check(`not ${override}`,name+'_no_override'),check(`not ${liveLink('b')}`,name+'_no_live_assignment')]),
 reset,observe('a','bolt','two',{evidence:{vehicle_origin:'bolt_selected'}}),perform(reconcile),check(`not ${override}`,'bolt_selected_not_live_override'),check(contractLink(),'bolt_selected_contract_fallback'),
 reset,observe('a','bolt','two'),check(liveLink('a','two',proof('bolt')),'bolt_live_current_car_wins'),
 reset,`update public.fleet_myclicar_contracts set eligible=false,vehicle_key=null,vehicle_candidates='{}' where external_id=${q(contract)};`,observe('a','bolt','two'),check(liveLink('a','two',proof('bolt')),'unusable_contract_does_not_block_real_live_car'),
 reset,observe('b'),check(`not ${liveLink('b','one',proof('uber',"now()-interval '1 second'"))}`,'unmatched_proof_timestamp_rejected'),
 `update public.fleet_drivers set auto_link_disabled=true,vehicle_link_method='manual',vehicle_key=${q(car('one'))} where id=${q(ids.a)};`,check(`not ${liveLink('b','one',proof('uber','now()',"||jsonb_build_object('expires_at',now()+interval '45 seconds')"))}`,'manual_holder_not_displaced'),check(held('a','one'),'manual_holder_kept'),
 reset,observe('a','uber','cross'),check(`not ${liveLink('a','cross')}`,'cross_agency_rejected'),
 reset,observe('b'),`update public.fleet_drivers set vehicle_key=${q(car('one'))},vehicle_link_method='platform_plate',vehicle_link_evidence=${proof('uber')} where id=${q(ids.a)};`,
 check(liveLink('b','one',proof('uber','now()',"||jsonb_build_object('expires_at',now()+interval '45 seconds')")),'old_stored_live_lease_does_not_block_shift'),check(held('a',null),'old_stored_live_lease_released'),
 reset,`update public.fleet_drivers set auto_link_disabled=true,vehicle_key=${q(car('one'))},vehicle_link_method='manual' where id=${q(ids.a)};`,
 check(`public.fleet_link_driver_automatic(${q(ids.a)},${q(code('a'))},null)=${q(ids.a)}::uuid`,'enable_automatic_rpc'),
 check(`(select link_method='manual' and not auto_link_disabled and vehicle_key is null and vehicle_link_method is null and vehicle_link_evidence='{}'::jsonb from public.fleet_drivers where id=${q(ids.a)})`,'manual_identity_automatic_vehicle_mode'),
 check(`exists(select 1 from public.fleet_link_audit where driver_id=${q(ids.a)} and action='vehicle_mode' and method='automatic')`,'automatic_mode_audited'),
 observe('a','uber','two'),check(liveLink('a','two',proof('uber','now()',"||jsonb_build_object('expires_at',now()+interval '45 seconds')")),'automatic_mode_follows_current_car'),
 check(`public.fleet_link_driver_automatic(${q(ids.unknown)},${q(code('a'))},null)=${q(ids.a)}::uuid`,'automatic_mode_merges_into_confirmed_person'),
 check(`not exists(select 1 from public.fleet_drivers where id=${q(ids.unknown)}) and exists(select 1 from public.fleet_identities where id=${q(ids.unknownUber)} and driver_id=${q(ids.a)})`,'identity_merge_preserved'),
 check(`(select link_method='manual' and ludy_driver_code=${q(code('a'))} and not auto_link_disabled and vehicle_key is null and vehicle_link_method is null from public.fleet_drivers where id=${q(ids.a)})`,'merged_person_keeps_manual_identity_with_auto_vehicles'),
 'reset role;rollback;',"select 'AUTOMATIC_VEHICLE_ASSIGNMENTS_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const localArgs=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x);
const result=spawnSync('docker',localArgs,{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
if(result.error||result.status!==0){
 const label=String(result.stderr||'').match(/auto-shift-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];
 throw new Error('Local automatic vehicle validation failed; transaction rolled back.'+(label?' Check: '+label:state?' SQLSTATE: '+state:' No database output disclosed.'));
}
assert.equal(result.stdout.trim(),'AUTOMATIC_VEHICLE_ASSIGNMENTS_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:withMigration,rolled_back:true}));
