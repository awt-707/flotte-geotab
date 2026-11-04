import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {assertLocalProject} from '../scripts/guard.mjs';
import {normalizeManualEvent} from '../server/event-catalog.mjs';
assertLocalProject();
const simulate=process.argv.includes('--with-migration');if(process.argv.slice(2).some(a=>a!=='--with-migration'))throw Error('Unexpected arguments');
const id=randomUUID(),users={admin:randomUUID(),manager:randomUUID(),viewer:randomUUID()},kept=randomUUID();
const q=value=>"'"+String(value).replaceAll("'","''")+"'",json=value=>q(JSON.stringify(value))+'::jsonb';
let checks=0;const check=(condition,label)=>{checks++;return `do $$ begin if (${condition}) is distinct from true then raise exception 'manual-event-test: ${label}';end if;end $$;`;};
const reject=(expression,label,exception='others')=>{checks++;return `do $$ declare refused boolean:=false;begin begin perform ${expression};exception when ${exception} then refused:=true;end;if not refused then raise exception 'manual-event-test: ${label}';end if;end $$;`;};
const row=normalizeManualEvent({title:'Synthetic event',city:'Casablanca',place:'Synthetic address',starts_local:'2026-11-04T19:00'}),changed=normalizeManualEvent({title:'Updated synthetic event',city:'Marrakech',place:'Changed address',starts_local:'2026-11-04T20:00'});
const call=(action='create',data=row,expected=null,user=users.admin)=>`public.ops_mutate_manual_event(${q(action)},${q(id)}::uuid,${expected===null?'null':q(expected)},${data===null?'null':json(data)},${q(user)}::uuid)`;
const service="reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';set local role service_role;";
const asUser=role=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(users[role])};set local request.jwt.claims=${q(JSON.stringify({sub:users[role],role:'authenticated'}))};`;
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 `insert into public.ops_events(id,source_id,external_key,source_url,city,title,place,starts_at,time_precision,fingerprint,observed_at) values(${q(kept)},'manual',${q(kept)},'','Casablanca','Existing synthetic manual','Existing address',now(),'minute',${q('f'.repeat(64))},now());`,
 ...(simulate?[readFileSync(new URL('../supabase/migrations/20261213000000_manual_events.sql',import.meta.url),'utf8')]:[]),
 check(`exists(select 1 from public.ops_events where id=${q(kept)})`,'existing_manual_preserved'),
 check("not exists(select 1 from public.ops_events where source_id<>'manual')",'collected_events_removed'),
 check('not exists(select 1 from public.ops_event_sources where enabled)','all_sources_stopped'),
 `insert into auth.users(id,email,aud,role) values ${Object.entries(users).map(([role,id])=>`(${q(id)},${q('manual-'+role+'-'+id+'@example.invalid')},'authenticated','authenticated')`).join(',')};`,
 ...Object.entries(users).map(([role,id])=>`update public.profiles set role=${q(role)} where user_id=${q(id)};`),service,
 reject(call('create',row,null,users.manager),'manager_reviewer_refused'),
 reject(call('create',{...row,place:''}),'missing_address_refused'),
 reject(call('create',{...row,starts_at:'infinity'}),'non_finite_date_refused'),
 check(`(${call()}->>'ok')::boolean`,'create_succeeds'),
 check(`(select status='approved' and reviewed_by=${q(users.admin)} from public.ops_events where id=${q(id)})`,'manual_admin_approval_saved'),
 check(`(${call()}->>'duplicate')::boolean`,'uncertain_retry_deduplicated'),
 check(`(select count(*) from public.ops_event_reviews where event_id=${q(id)})=1`,'retry_no_duplicate_audit'),
 check(`(${call('create',changed)}->>'conflict')::boolean`,'create_cannot_replace_existing'),
 check(`(${call('update',changed,'b'.repeat(64))}->>'conflict')::boolean`,'stale_update_refused'),
 check(`(${call('update',changed,row.fingerprint)}->>'ok')::boolean`,'current_update_succeeds'),
 check(`(select title=${q(changed.title)} and place=${q(changed.place)} and city='Marrakech' from public.ops_events where id=${q(id)})`,'updated_fields_saved'),
 check(`(select count(*) from public.ops_event_reviews where event_id=${q(id)})=2`,'edit_audited'),
 ...['admin','manager','viewer'].flatMap(role=>[asUser(role),check(`exists(select 1 from public.ops_events where id=${q(id)})`,role+'_reads_event'),reject(call('delete',null,changed.fingerprint),role+'_no_direct_rpc','insufficient_privilege')]),
 'reset role;set local role anon;',reject(`(select count(*) from public.ops_events)`,'anonymous_cannot_read','insufficient_privilege'),reject(call(),'anonymous_cannot_create','insufficient_privilege'),service,
 reject(`public.ops_ingest_events('if-maroc',${json([{...row,external_key:randomUUID(),source_url:''}])},now())`,'old_collector_cannot_repopulate'),
 check(`(${call('delete',null,row.fingerprint)}->>'conflict')::boolean`,'stale_delete_refused'),
 check(`exists(select 1 from public.ops_events where id=${q(id)})`,'failed_delete_preserves_row'),
 check(`(${call('delete',null,changed.fingerprint)}->>'ok')::boolean`,'delete_succeeds'),
 check(`not exists(select 1 from public.ops_events where id=${q(id)}) and not exists(select 1 from public.ops_event_reviews where event_id=${q(id)})`,'delete_atomic'),
 check(`(${call('update',changed,changed.fingerprint)}->>'missing')::boolean`,'deleted_event_not_recreated'),
 "update public.params set value='not-staging' where key='environment';",reject(call(),'staging_guard_required'),
 "reset role;rollback;select 'MANUAL_EVENTS_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x),{env,input:sql,encoding:'utf8',timeout:40000,maxBuffer:1024*1024});
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/manual-event-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Manual event validation failed; transaction rolled back. '+(label||state||'Local database unavailable'));}
assert.equal(result.stdout.trim(),'MANUAL_EVENTS_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:simulate,rolled_back:true}));
