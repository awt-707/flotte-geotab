// Run only against pinned local staging; all fixtures and optional migration roll back.
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {assertLocalProject} from '../scripts/guard.mjs';
import {normalizeDemandImport} from '../server/demand-analytics.mjs';
import {eventFingerprint} from '../server/event-catalog.mjs';
assertLocalProject();
const args=process.argv.slice(2);if(args.length>1||args.some(arg=>arg!=='--with-migration'))throw Error('Only --with-migration is supported');
const simulate=args.includes('--with-migration'),suffix=randomUUID(),agency=Date.now()*1000+randomInt(900),now=Date.now(),at=new Date(now).toISOString();
const users=Object.fromEntries(['admin','manager','viewer','pending'].map(role=>[role,randomUUID()]));
const q=value=>"'"+String(value).replaceAll("'","''")+"'",json=value=>q(JSON.stringify(value))+'::jsonb';
let checks=0;
const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'ops-test: ${label}';end if;end $test$;`;};
const reject=(statement,label,exception='others')=>{checks++;return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'ops-test: ${label}';end if;end $test$;`;};
const perform=statement=>`do $work$ begin perform ${statement};end $work$;`;
const service="reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';set local role service_role;";
const auth=role=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(users[role])};set local request.jwt.claims=${q(JSON.stringify({sub:users[role],role:'authenticated'}))};`;
const imported=normalizeDemandImport({agency_id:agency,city:'Casablanca',file_name:'synthetic.xlsx',rows:[{external_id:'A'+suffix,started_at:new Date(now-3600000).toISOString(),pickup_zone:'Synthetic Zone',status:'completed'}]},{now});
const other=normalizeDemandImport({agency_id:agency+1,city:'Marrakech',file_name:'synthetic-other.xlsx',rows:[{external_id:'B'+suffix,started_at:new Date(now-7200000).toISOString(),pickup_zone:'Synthetic Other Zone',status:'completed'}]},{now});
const importSql=(info=imported,rows=info.rows)=>`public.ops_import_demand(${json(info)},${json(rows)})`;
const event={external_key:'synthetic-'+suffix,source_url:'https://example.invalid/'+suffix,city:'Casablanca',title:'Synthetic Event',place:'Synthetic Venue',starts_at:new Date(now+3600000).toISOString(),ends_at:null,source_date_text:'Synthetic date',time_precision:'minute',status:'approved',reviewed_by:users.admin};event.fingerprint=eventFingerprint(event);
const changed={...event,title:'Changed synthetic event'};changed.fingerprint=eventFingerprint(changed);
const noDate={...event,external_key:'synthetic-undated-'+suffix,starts_at:null,time_precision:'unknown'};noDate.fingerprint=eventFingerprint(noDate);
const ingest=rows=>`public.ops_ingest_events('manual',${json(rows)},${q(at)}::timestamptz)`;
const eventId=`(select id from public.ops_events where source_id='manual' and external_key=${q(event.external_key)})`;
const review=(fingerprint=event.fingerprint,decision='approved',user=users.admin,id=eventId)=>`public.ops_review_event(${id},${fingerprint===null?'null':q(fingerprint)},${decision===null?'null':q(decision)},${q(user)}::uuid)`;
const changedImport={...imported,fingerprint:'d'.repeat(64)},invalidRow={...imported.rows[0],ride_key:'e'.repeat(64),status:'invalid'};
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(simulate?[readFileSync(new URL('../supabase/migrations/20261129000000_operations_growth.sql',import.meta.url),'utf8')]:[]),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic Ops A','Casablanca'),(${agency+1},'Synthetic Ops B','Marrakech');`,
 `insert into auth.users(id,email,aud,role) values ${Object.entries(users).map(([role,id])=>`(${q(id)},${q('ops-'+role+'-'+suffix+'@example.invalid')},'authenticated','authenticated')`).join(',')};`,
 ...Object.entries(users).map(([role,id])=>`update public.profiles set role=${q(role)} where user_id=${q(id)};`),
 `insert into public.user_agencies(user_id,agency_id) values(${q(users.manager)},${agency}),(${q(users.viewer)},${agency});`,service,
 check(`(${importSql()}->>'inserted')::int=1`,'real_normalizer_output_imported'),
 check(`(${importSql()}->>'duplicate')::boolean`,'file_replay_deduplicated'),
 check(`(select count(*) from public.ops_demand_imports where agency_id=${agency})=1`,'replay_does_not_add_import'),
 check(`(select count(*) from public.ops_demand_rides where agency_id=${agency})=1`,'replay_does_not_duplicate_rides'),
 perform(importSql(other)),
 `insert into public.ops_rush_rules(agency_id,city,days,start,"end",enabled) values(${agency},'Casablanca','[1,2,3]','07:00','10:00',true),(${agency+1},'Marrakech','[1]','18:00','21:00',true);`,
 ...['admin','manager','viewer','pending'].flatMap(role=>[auth(role),
 ...['ops_demand_imports','ops_demand_rides','ops_rush_rules'].map(table=>check(`(select count(*) from public.${table} where agency_id in(${agency},${agency+1}))=${role==='admin'?2:role==='pending'?0:1}`,role+'_scope_'+table)),
 reject(`perform ${importSql()}`,role+'_cannot_import_directly','insufficient_privilege'),
 reject(`perform ${ingest([event])}`,role+'_cannot_ingest_directly','insufficient_privilege'),
 reject(`update public.ops_rush_rules set enabled=false where agency_id=${agency}`,role+'_cannot_write_rules_directly','insufficient_privilege'),
 reject('perform 1 from public.ops_fuel_checkpoints limit 1',role+'_cannot_read_private_checkpoints','insufficient_privilege')]),
 'reset role;set local role anon;',
 ...['ops_demand_imports','ops_demand_rides','ops_rush_rules','ops_events','ops_event_sources','ops_event_reviews','ops_fuel_settings','ops_fuel_checkpoints'].map(table=>reject(`perform 1 from public.${table} limit 1`,'anonymous_cannot_read_'+table,'insufficient_privilege')),
 reject(`perform ${importSql()}`,'anonymous_cannot_import','insufficient_privilege'),service,
 reject(`perform ${importSql(changedImport,[imported.rows[0],invalidRow])}`,'invalid_late_row_rolls_back_import'),
 check(`not exists(select 1 from public.ops_demand_imports where agency_id=${agency} and fingerprint=${q(changedImport.fingerprint)})`,'failed_import_header_rolled_back'),
 check(`(select count(*) from public.ops_demand_rides where agency_id=${agency})=1`,'failed_import_rows_rolled_back'),
 reject(`perform ${importSql({...changedImport,fingerprint:'f'.repeat(64)},[imported.rows[0],imported.rows[0]])}`,'duplicate_row_keys_refused_atomically'),
 check(`not exists(select 1 from public.ops_demand_imports where agency_id=${agency} and fingerprint=${q('f'.repeat(64))})`,'duplicate_row_header_rolled_back'),
 reject(`perform ${importSql(changedImport,[])}`,'empty_import_refused'),
 check(`(${importSql({...changedImport,fingerprint:'c'.repeat(64)},[{...imported.rows[0],status:'cancelled'}])}->>'inserted')::int=1`,'overlapping_report_updates_same_ride'),
 check(`(select count(*) from public.ops_demand_rides where agency_id=${agency})=1 and (select status='cancelled' from public.ops_demand_rides where agency_id=${agency})`,'overlap_no_duplicate'),
 check(`${ingest([event])}=1`,'event_ingest_succeeds'),
 check(`(select status='pending' and reviewed_by is null and reviewed_at is null from public.ops_events where id=${eventId})`,'source_cannot_auto_approve'),
 ...['manager','viewer'].flatMap(role=>[auth(role),check(`exists(select 1 from public.ops_events where id=${eventId})`,role+'_can_read_event'),reject(`perform ${review()}`,role+'_cannot_call_review_rpc','insufficient_privilege')]),service,
 reject(`perform ${review(null)}`,'null_review_fingerprint_refused'),
 reject(`perform ${review('b'.repeat(64))}`,'changed_review_fingerprint_refused'),
 reject(`perform ${review(event.fingerprint,'approved',users.manager)}`,'non_admin_reviewer_refused'),
 reject(`perform ${review(event.fingerprint,null)}`,'null_decision_refused'),
 check(`(select status='pending' from public.ops_events where id=${eventId})`,'failed_reviews_leave_pending'),
 check(review(),'admin_review_succeeds'),
 check(`(select status='approved' and reviewed_by=${q(users.admin)}::uuid from public.ops_events where id=${eventId})`,'approval_saved_with_reviewer'),
 check(`(select count(*) from public.ops_event_reviews where event_id=${eventId})=1`,'approval_audited'),
 perform(ingest([event])),check(`(select status='approved' from public.ops_events where id=${eventId})`,'unchanged_source_preserves_approval'),
 perform(ingest([changed])),check(`(select status='pending' and reviewed_at is null and reviewed_by is null from public.ops_events where id=${eventId})`,'source_change_requires_new_human_review'),
 reject(`perform ${review(event.fingerprint)}`,'stale_approval_cannot_race_changed_source'),
 check(review(changed.fingerprint,'rejected'),'human_rejection_saved'),
 perform(ingest([changed])),check(`(select status='rejected' from public.ops_events where id=${eventId})`,'same_source_cannot_reapprove_rejected'),
 perform(ingest([noDate])),
 reject(`perform ${review(noDate.fingerprint,'approved',users.admin,`(select id from public.ops_events where source_id='manual' and external_key=${q(noDate.external_key)})`)}`,'unknown_date_cannot_be_approved'),
 reject(`perform ${ingest([{...event,external_key:'atomic-'+suffix},{...event,external_key:'invalid-'+suffix,city:'Unknown'}])}`,'invalid_event_batch_is_atomic'),
 check(`not exists(select 1 from public.ops_events where external_key=${q('atomic-'+suffix)})`,'event_batch_partial_rows_rolled_back'),
 "update public.params set value='not-staging' where key='environment';",
 reject(`perform ${importSql()}`,'import_requires_staging'),reject(`perform ${ingest([event])}`,'ingest_requires_staging'),reject(`perform ${review(changed.fingerprint)}`,'review_requires_staging'),
 "reset role;rollback;select 'OPERATIONS_GROWTH_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(arg=>arg==='--username=postgres'?'--username=supabase_admin':arg),{env,input:sql,encoding:'utf8',timeout:40000,maxBuffer:1024*1024});
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/ops-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Local operations validation failed; transaction rolled back.'+(label?' Check: '+label:state?' SQLSTATE: '+state:''));}
assert.equal(result.stdout.trim(),'OPERATIONS_GROWTH_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:simulate,rolled_back:true}));
