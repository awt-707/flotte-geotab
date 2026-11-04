// Pinned local Supabase only. Migration, settings and synthetic fixtures all roll back.
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {assertLocalProject} from '../scripts/guard.mjs';
import {advanceDisconnection} from '../server/platform-disconnections.mjs';
assertLocalProject();
const args=process.argv.slice(2);if(args.length>1||args.some(x=>x!=='--with-migration'))throw new Error('Only --with-migration is supported.');
const withMigration=args.includes('--with-migration'),suffix=randomUUID(),q=v=>"'"+String(v).replaceAll("'","''")+"'",json=v=>q(JSON.stringify(v))+'::jsonb';
const ids=Object.fromEntries(['a','b','merge','removed','aUber','bBolt','mergeBolt','removedUber','eventA','eventB','eventMerge','eventRemoved','admin','manager','viewer'].map(x=>[x,randomUUID()]));
const agency=Date.now()*1000+randomInt(900),car='DISCONNECT_CAR_'+suffix,code='DISCONNECT_CODE_'+suffix;
const now=Date.now()-1000,iso=ms=>new Date(ms).toISOString(),online=iso(now-15000),offline=iso(now),at=iso(now+500),future=iso(now+60000);
const duty='contract:'+suffix,eventIDs=['eventA','eventB','eventMerge','eventRemoved'].map(x=>q(ids[x])).join(',');
const state=(identity='aUber',extra={})=>({identity_id:ids[identity],state:{version:1,identity_id:ids[identity],source:identity.endsWith('Bolt')?'bolt':'uber',driver_id:ids[identity==='aUber'?'a':identity==='bBolt'?'b':identity==='mergeBolt'?'merge':'removed'],duty_key:duty,policy:'any',status:'offline',observed_at:offline,online_at:online,offline_at:offline},updated_at:at,...extra});
const alert=(identity='aUber',driver='a',event='eventA',extra={})=>({id:ids[event],identity_id:ids[identity],driver_id:ids[driver],source:identity.endsWith('Bolt')?'bolt':'uber',vehicle_key:null,contract_id:'LOCAL-CONTRACT-'+suffix,duty_key:duty,observed_online_at:online,disconnected_at:offline,last_seen_at:at,evidence:{kind:'platform_disconnection',policy:'any',duty:{mode:'contract'},previous_status:'on_trip',status:'offline'},...extra});
const change=(event,status,extra={})=>({id:ids[event],status,last_seen_at:at,resolved_at:status==='resolved'?at:null,...extra});
const commit=(states=[],alerts=[],changes=[])=>`public.fleet_commit_disconnections(${json(states)},${json(alerts)},${json(changes)})`;
const perform=expression=>`do $work$ begin perform ${expression}; end $work$;`;
let checks=0;
const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'disconnect-test: ${label}'; end if; end $test$;`;};
const reject=(statement,label,error='raise_exception')=>{checks++;return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when ${error} then refused:=true;end;if not refused then raise exception 'disconnect-test: ${label}';end if;end $test$;`;};
const service="reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';set local role service_role;";
const auth=x=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(ids[x])};set local request.jwt.claims=${q(JSON.stringify({sub:ids[x],role:'authenticated'}))};`;
// Send the actual detector output through the real SQL contract as well as the
// malformed synthetic batches below. Everything remains in this transaction.
const detectorDuty={driver_id:ids.a,duty_key:duty,contract_id:'LOCAL-CONTRACT-'+suffix,
  contract_fingerprint:'a'.repeat(64),started_at:iso(now-60000),evidence:{mode:'contract'}};
const detectorRow={identity_id:ids.aUber,driver_id:ids.a,source:'uber',status:'on_trip',observed_at:online};
const detectorSource={id:'uber',status:'healthy',last_success_at:at,stale_after_s:45};
const baseline=advanceDisconnection(null,{row:detectorRow,source:detectorSource,duty:detectorDuty,now:now+500});
const transition=advanceDisconnection(baseline.state,{row:{...detectorRow,status:'offline',observed_at:offline},source:detectorSource,duty:detectorDuty,now:now+500});
assert.ok(transition.event,'the real detector must emit the observed transition');
const states=[{identity_id:ids.aUber,state:transition.state,updated_at:at},state('bBolt')],
  alerts=[{...transition.event,id:ids.eventA,opened_at:at,last_seen_at:at,status:'open'},alert('bBolt','b','eventB')];
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(withMigration?[readFileSync(new URL('../supabase/migrations/20261128000000_disconnection_alerts.sql',import.meta.url),'utf8')]:[]),
 check("to_regclass('public.fleet_disconnection_alerts') is not null",'migration_available'),
 ...(withMigration?[check("(select not disconnection_enabled and disconnection_policy='any' and duty_mode='contract' from public.fleet_settings where id=1)",'feature_disabled_by_default')]:[]),
 perform("pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0))"),
 `insert into public.agencies(id,name) overriding system value values(${agency},'Synthetic Disconnect A'),(${agency+1},'Synthetic Disconnect B');
 insert into public.vehicles(key,plate,agency_id) values(${q(car)},'SYNTHETIC-DISCONNECT',${agency});
 insert into public.drivers(code,name,agency_id) values(${q(code)},'Synthetic Disconnect Alpha',${agency});
 insert into public.fleet_drivers(id,name,agency_id,ludy_driver_code) values
 (${q(ids.a)},'Synthetic Disconnect Alpha',${agency},${q(code)}),(${q(ids.b)},'Synthetic Disconnect Bravo',${agency+1},null),
 (${q(ids.merge)},'Synthetic Disconnect Merge',${agency},null),(${q(ids.removed)},'Synthetic Disconnect Removed',${agency},null);
 insert into public.fleet_identities(id,driver_id,source,source_key) values ${[['aUber','a','uber'],['bBolt','b','bolt'],['mergeBolt','merge','bolt'],['removedUber','removed','uber']].map(([identity,driver,source])=>`(${q(ids[identity])},${q(ids[driver])},${q(source)},${q(identity+suffix)})`).join(',')};
 insert into auth.users(id,email,aud,role) values ${['admin','manager','viewer'].map(x=>`(${q(ids[x])},${q('disconnect-'+x+'-'+suffix+'@example.invalid')},'authenticated','authenticated')`).join(',')};`,
 ...['admin','manager','viewer'].map(x=>`update public.profiles set role=${q(x)} where user_id=${q(ids[x])};`),
 `insert into public.user_agencies(user_id,agency_id) values(${q(ids.manager)},${agency}),(${q(ids.viewer)},${agency});`,service,
 reject("update public.fleet_settings set disconnection_policy='invalid' where id=1",'invalid_policy_rejected','check_violation'),
 reject("update public.fleet_settings set duty_mode='invalid' where id=1",'invalid_duty_mode_rejected','check_violation'),
 check(`(${commit(states,alerts)}->>'alerts_created')::int=2`,'first_commit_creates_events'),
 check(`(select count(*) from public.fleet_disconnection_checkpoints where identity_id in(${q(ids.aUber)},${q(ids.bBolt)}))=2`,'checkpoint_snapshot_saved'),
 check(`(select vehicle_key is null and status='open' and evidence->>'previous_status'='on_trip' from public.fleet_disconnection_alerts where id=${q(ids.eventA)})`,'event_without_vehicle_kept'),
 check(`(${commit(states,alerts)}->>'alerts_created')::int=0`,'retry_deduplicated'),
 check(`(${commit(states,[alert('aUber','a','eventA',{id:randomUUID(),evidence:{kind:'platform_disconnection',policy:'any',changed:true}})])}->>'alerts_created')::int=0`,'unique_episode_preserves_original_id'),
 check(`(select evidence->>'previous_status'='on_trip' and not evidence?'changed' from public.fleet_disconnection_alerts where id=${q(ids.eventA)})`,'retry_preserves_original_evidence'),
 ...['admin','manager','viewer'].flatMap(x=>[auth(x),
 check(`(select count(*) from public.fleet_disconnection_alerts where id in(${eventIDs}))=${x==='admin'?2:1}`,x+'_driver_agency_read_scope'),
 check(`exists(select 1 from public.fleet_disconnection_alerts where id=${q(ids.eventA)} and vehicle_key is null)`,x+'_can_read_without_vehicle'),
 reject('perform 1 from public.fleet_disconnection_checkpoints limit 1',x+'_cannot_read_checkpoint','insufficient_privilege'),
 reject(`perform ${commit()}`,x+'_cannot_commit','insufficient_privilege'),
 reject(`update public.fleet_disconnection_alerts set status='suspended' where id=${q(ids.eventA)}`,x+'_cannot_write_events','insufficient_privilege')]),
 'reset role;set local role anon;',reject('perform 1 from public.fleet_disconnection_alerts limit 1','anonymous_cannot_read','insufficient_privilege'),
 reject('perform 1 from public.fleet_disconnection_checkpoints limit 1','anonymous_cannot_read_checkpoint','insufficient_privilege'),
 reject(`perform ${commit()}`,'anonymous_cannot_commit','insufficient_privilege'),service,
 reject('perform public.fleet_preserve_disconnections_on_merge()','service_cannot_call_trigger_function','insufficient_privilege'),
 check(`(${commit([state()],[],[change('eventA','suspended')])}->>'changes_applied')::int=1`,'explicit_suspend'),
 check(`(select count(*) from public.fleet_disconnection_checkpoints)=1`,'absent_checkpoint_removed'),
 check(`(select status='suspended' from public.fleet_disconnection_alerts where id=${q(ids.eventA)})`,'suspension_saved'),
 check(`(${commit([state()],[],[change('eventA','open')])}->>'changes_applied')::int=1`,'explicit_resume_same_episode'),
 check(`(${commit([state()],[],[change('eventA','resolved')])}->>'changes_applied')::int=1`,'explicit_return_resolves'),
 check(`(${commit([state()],[],[change('eventA','resolved')])}->>'changes_applied')::int=0`,'same_resolution_retry_idempotent'),
 perform(commit([state()],[alert()])),check(`(select status='resolved' and resolved_at=${q(at)}::timestamptz from public.fleet_disconnection_alerts where id=${q(ids.eventA)})`,'event_replay_cannot_reopen_resolved'),
 reject(`perform ${commit([state()],[],[change('eventA','open')])}`,'resolved_episode_terminal'),
 ...[
 ['missing_state_identity',[state('aUber',{identity_id:randomUUID()})]],
 ['duplicate_state_identity',[state(),state()]],
 ['state_identity_mismatch',[state('aUber',{state:{identity_id:ids.bBolt}})]],
 ['state_source_mismatch',[state('aUber',{state:{source:'bolt'}})]],
 ['future_state',[state('aUber',{updated_at:future})]],
 ['infinite_state',[state('aUber',{updated_at:'infinity'})]],
 ['array_state',[state('aUber',{state:[]})]],
 ['extra_envelope_field',[{...state(),external_payload:{raw:true}}]],
 ['wrong_state_version',[state('aUber',{state:{...state().state,version:2}})]],
 ['wrong_state_driver',[state('aUber',{state:{...state().state,driver_id:ids.b}})]],
 ['wrong_state_policy',[state('aUber',{state:{...state().state,policy:'guess'}})]],
 ['unknown_state_status',[state('aUber',{state:{...state().state,status:'unknown'}})]],
 ['state_raw_payload',[state('aUber',{state:{...state().state,raw_payload:{external:true}}})]],
 ['state_observed_after_snapshot',[state('aUber',{state:{...state().state,observed_at:future}})]],
 ['state_online_after_observation',[state('aUber',{state:{...state().state,online_at:at}})]],
 ['infinite_state_observation',[state('aUber',{state:{...state().state,observed_at:'infinity'}})]]
 ].flatMap(([name,invalid])=>[reject(`perform ${commit(invalid)}`,name+'_rejected'),check(`exists(select 1 from public.fleet_disconnection_checkpoints where identity_id=${q(ids.aUber)})`,name+'_atomic_snapshot')]),
 ...[
 ['wrong_driver',alert('aUber','b')],['wrong_source',alert('aUber','a','eventA',{source:'bolt'})],
 ['missing_identity',alert('aUber','a','eventA',{identity_id:randomUUID()})],['missing_vehicle',alert('aUber','a','eventA',{vehicle_key:'missing-'+suffix})],
 ['missing_duty',alert('aUber','a','eventA',{duty_key:''})],['reverse_transition',alert('aUber','a','eventA',{observed_online_at:offline})],
 ['future_transition',alert('aUber','a','eventA',{disconnected_at:future})],['infinite_transition',alert('aUber','a','eventA',{disconnected_at:'infinity'})],
 ['invalid_evidence',alert('aUber','a','eventA',{evidence:[]})],['initial_resolved',alert('aUber','a','eventA',{status:'resolved',resolved_at:at})],
 ['initial_suspended',alert('aUber','a','eventA',{status:'suspended'})],
 ['missing_evidence_kind',alert('aUber','a','eventA',{evidence:{policy:'any'}})],['invalid_duty_evidence',alert('aUber','a','eventA',{evidence:{kind:'platform_disconnection',policy:'any',duty:[]}})]
 ].map(([name,invalid])=>reject(`perform ${commit([state()],[invalid])}`,name+'_rejected')),
 reject(`perform ${commit([state()],[alert(),alert()])}`,'duplicate_episode_in_batch_rejected'),
 reject(`perform ${commit([state()],[],[change('eventB','suspended'),change('eventB','open')])}`,'duplicate_change_rejected'),
 reject(`perform ${commit([state()],[],[{id:randomUUID(),status:'open',last_seen_at:at,resolved_at:null}])}`,'missing_event_change_rejected'),
 reject(`perform ${commit([state()],[],[change('eventB','resolved',{resolved_at:null})])}`,'resolved_without_return_time_rejected'),
 reject(`perform ${commit([state()],[],[change('eventB','suspended',{last_seen_at:online})])}`,'backwards_change_rejected'),
 reject(`perform ${commit([state()],[alert('aUber','a','eventA',{duty_key:'new-duty'})])}`,'late_duplicate_primary_key_rejected','unique_violation'),
 check(`(select count(*) from public.fleet_disconnection_alerts where id in(${eventIDs}))=2 and exists(select 1 from public.fleet_disconnection_checkpoints where identity_id=${q(ids.aUber)})`,'late_failure_rolls_back_entire_commit'),
 reject(`perform ${commit([state('aUber',{updated_at:future})],[],[change('eventB','suspended')])}`,'invalid_checkpoint_rejects_other_lifecycle_changes'),
 check(`(select status='open' from public.fleet_disconnection_alerts where id=${q(ids.eventB)})`,'failed_commit_preserves_event_lifecycle'),
 reject(`perform public.fleet_commit_disconnections(null,'[]','[]')`,'null_batch_rejected'),
 reject(`perform public.fleet_commit_disconnections((select jsonb_agg(${json(state())}) from generate_series(1,5001)),'[]','[]')`,'oversized_batch_rejected'),
 perform(commit([state(),state('mergeBolt'),state('removedUber')],[alert('mergeBolt','merge','eventMerge'),alert('removedUber','removed','eventRemoved',{vehicle_key:car})])),
 check(`public.fleet_link_driver_automatic(${q(ids.merge)},${q(code)},null)=${q(ids.a)}::uuid`,'merge_uses_canonical_profile'),
 check(`(select driver_id=${q(ids.a)}::uuid and identity_id=${q(ids.mergeBolt)}::uuid from public.fleet_disconnection_alerts where id=${q(ids.eventMerge)})`,'merge_preserves_event_id_and_owner'),
 check(`exists(select 1 from public.fleet_disconnection_checkpoints where identity_id=${q(ids.mergeBolt)})`,'merge_preserves_identity_checkpoint'),
 check(`(select state->>'driver_id'=${q(ids.a)} and updated_at=${q(at)}::timestamptz from public.fleet_disconnection_checkpoints where identity_id=${q(ids.mergeBolt)})`,'merge_repoints_checkpoint_without_refreshing_it'),
 `delete from public.vehicles where key=${q(car)};`,check(`(select vehicle_key is null from public.fleet_disconnection_alerts where id=${q(ids.eventRemoved)})`,'vehicle_removal_retains_driver_event'),
 `delete from public.fleet_drivers where id=${q(ids.removed)};`,check(`not exists(select 1 from public.fleet_disconnection_alerts where id=${q(ids.eventRemoved)}) and not exists(select 1 from public.fleet_disconnection_checkpoints where identity_id=${q(ids.removedUber)})`,'normal_profile_deletion_cascades'),
 check(`(${commit()}->>'states_removed')::int>=1`,'empty_snapshot_clears_checkpoints'),
 check('not exists(select 1 from public.fleet_disconnection_checkpoints)','empty_snapshot_safeupdate_compatible'),
 check(`exists(select 1 from public.fleet_disconnection_alerts where id=${q(ids.eventMerge)})`,'empty_checkpoint_snapshot_keeps_events'),
 "update public.params set value='not-staging' where key='environment';",reject(`perform ${commit()}`,'non_staging_guard'),
 'reset role;rollback;',"select 'DISCONNECTION_ALERTS_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const localArgs=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x);
const result=spawnSync('docker',localArgs,{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/disconnect-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw new Error('Local disconnection validation failed; transaction rolled back.'+(label?' Check: '+label:state?' SQLSTATE: '+state:' No database output disclosed.'));}
assert.equal(result.stdout.trim(),'DISCONNECTION_ALERTS_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:withMigration,rolled_back:true}));
