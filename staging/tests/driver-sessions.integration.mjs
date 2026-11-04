// Local database only. All fixtures, RPC calls and optional migration roll back.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
assertLocalProject();
const args=process.argv.slice(2);if(args.length>1||args.some(arg=>arg!=='--with-migration'))throw Error('Only --with-migration supported');
const simulate=args.includes('--with-migration'),id=randomUUID(),admin=randomUUID(),viewer=randomUUID(),suffix=randomUUID(),driverCode='SESSION_TEST_'+suffix;
const q=value=>"'"+String(value).replaceAll("'","''")+"'",digest=char=>q(char.repeat(64));
const login=(credential='a',token='b')=>`public.driver_portal_login(${digest(credential)},${digest(token)})`;
const rotate=(credential='c',user=admin)=>`public.driver_portal_rotate(${q(id)}::uuid,${credential===null?'null':digest(credential)},${q(user)}::uuid)`;
let checks=0;const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'driver-session-test: ${label}';end if;end $test$;`;};
const reject=(statement,label,exception='others')=>{checks++;return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'driver-session-test: ${label}';end if;end $test$;`;};
const perform=statement=>`do $work$ begin perform ${statement};end $work$;`;
const signatures=['public.driver_portal_login(text,text)','public.driver_portal_rotate(uuid,text,uuid)'];
const sql=["begin;set local lock_timeout='2s';set local statement_timeout='20s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 `create temp table prior_portal_permissions as select p.oid,has_function_privilege('authenticated',p.oid,'EXECUTE') as staff,has_function_privilege('service_role',p.oid,'EXECUTE') as service,has_function_privilege('anon',p.oid,'EXECUTE') as anon,p.prosecdef,p.prorettype from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f';`,
 ...(simulate?[readFileSync(new URL('../supabase/migrations/20261204000000_driver_sessions.sql',import.meta.url),'utf8')]:[]),
 check(`not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and p.prokind='f' and p.prorettype<>'trigger'::regtype and has_function_privilege('anon',p.oid,'EXECUTE'))`,'no_anonymous_business_definer_rpc'),
 check(`not exists(select 1 from prior_portal_permissions p where staff and not has_function_privilege('authenticated',p.oid,'EXECUTE'))`,'existing_staff_permissions_preserved'),
 check(`not exists(select 1 from prior_portal_permissions p where service and not has_function_privilege('service_role',p.oid,'EXECUTE'))`,'existing_service_permissions_preserved'),
 check(`not exists(select 1 from prior_portal_permissions p where (not prosecdef or prorettype='trigger'::regtype) and anon is distinct from has_function_privilege('anon',p.oid,'EXECUTE'))`,'auth_triggers_and_pure_formatters_unchanged'),
 ...signatures.flatMap(signature=>[
  check(`has_function_privilege('service_role',${q(signature)},'EXECUTE')`,'service_rpc_'+signature.includes('login')),
  ...['anon','authenticated'].map(role=>check(`not has_function_privilege(${q(role)},${q(signature)},'EXECUTE')`,role+'_cannot_execute_'+(signature.includes('login')?'login':'rotate'))),
  check(`position('for update' in lower(pg_get_functiondef(${q(signature)}::regprocedure)))>0`,'account_row_lock_'+(signature.includes('login')?'login':'rotate'))
 ]),
 `insert into auth.users(id,email,aud,role) values(${q(admin)},${q('portal-admin-'+suffix+'@example.invalid')},'authenticated','authenticated'),(${q(viewer)},${q('portal-viewer-'+suffix+'@example.invalid')},'authenticated','authenticated');`,
 `update public.profiles set role='admin' where user_id=${q(admin)};update public.profiles set role='viewer' where user_id=${q(viewer)};`,
 `insert into public.drivers(code,name) values(${q(driverCode)},'Synthetic session driver');`,
 `insert into public.driver_portal_accounts(id,ludy_driver_code,display_name,credential_hash) values(${q(id)},${q(driverCode)},'Synthetic session driver',${digest('a')});`,
 `set local role service_role;`,
 check(`(${login()}->>'name')='Synthetic session driver'`,'login_returns_own_name'),
 check(`(select expires_at-created_at=interval '12 hours' from public.driver_portal_sessions where token_hash=${digest('b')})`,'session_duration_twelve_hours'),
 check(`(select account_id=${q(id)} from public.driver_portal_sessions where token_hash=${digest('b')})`,'session_bound_to_exact_account'),
 check(`${login('d','e')} is null`,'invalid_credential_creates_no_session'),
 reject(`perform public.driver_portal_login(null,${digest('f')})`,'null_credential_refused'),
 reject(`perform public.driver_portal_login(${digest('a')},'invalid')`,'invalid_token_digest_refused'),
 reject(`perform ${rotate('c',viewer)}`,'nonadmin_rotation_refused'),
 check(`exists(select 1 from public.driver_portal_sessions where token_hash=${digest('b')})`,'refused_rotation_keeps_existing_session'),
 check(`(${rotate()}->>'active')::boolean`,'rotation_reactivates_account'),
 check(`not exists(select 1 from public.driver_portal_sessions where account_id=${q(id)})`,'rotation_deletes_all_old_sessions'),
 check(`${login('a','d')} is null`,'old_credential_invalid_after_rotation'),
 check(`${login('c','e')} is not null`,'new_credential_opens_session'),
 check(`not (${rotate(null)}->>'active')::boolean`,'revocation_disables_account'),
 check(`${login('c','f')} is null`,'revoked_credential_refused'),
 check(`not exists(select 1 from public.driver_portal_sessions where account_id=${q(id)})`,'revocation_deletes_all_sessions'),
 check(`public.driver_portal_rotate(${q(randomUUID())},${digest('f')},${q(admin)}) is null`,'unknown_account_has_no_effect'),
 ...['anon','authenticated'].flatMap(role=>[`reset role;set local role ${role};`,
  reject(`perform ${login('c','b')}`,role+'_rpc_login_denied','insufficient_privilege'),
  reject(`perform ${rotate()}`,role+'_rpc_rotate_denied','insufficient_privilege')]),
 `reset role;set local role service_role;update public.params set value='not-staging' where key='environment';`,
 reject(`perform ${login()}`,'login_requires_staging'),reject(`perform ${rotate()}`,'rotation_requires_staging'),
 "reset role;rollback;select 'DRIVER_SESSIONS_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(arg=>arg==='--username=postgres'?'--username=supabase_admin':arg),{env,input:sql,encoding:'utf8',timeout:30000,maxBuffer:1048576});
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/driver-session-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Local driver session validation failed; transaction rolled back.'+(label?' Check: '+label:state?' SQLSTATE: '+state:''));}
assert.equal(result.stdout.trim(),'DRIVER_SESSIONS_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:simulate,rolled_back:true}));
