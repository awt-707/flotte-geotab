import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {randomUUID,randomInt} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';

assertLocalProject();if(process.argv.length!==2)throw Error('No target options accepted.');
const admin=randomUUID(),manager=randomUUID(),viewer=randomUUID(),pending=randomUUID(),agency=Date.now()*1000+randomInt(500);
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
const owner="reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';";
const auth=id=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(id)};set local request.jwt.claims=${q(JSON.stringify({sub:id,role:'authenticated'}))};`;
let checks=0;
const check=(condition,label)=>{checks++;return `do $$begin if (${condition}) is distinct from true then raise exception 'fleet-source-health-test: ${label}';end if;end$$;`;};
const reject=(statement,label)=>{checks++;return `do $$declare denied boolean:=false;begin begin ${statement};exception when sqlstate '42501' then denied:=true;end;if not denied then raise exception 'fleet-source-health-test: ${label}';end if;end$$;`;};
const sql=['begin;',"set local statement_timeout='20s';set local lock_timeout='2s';",LOCAL_GUARD,
 `create temp table source_acl_before as select relacl,relrowsecurity from pg_class where oid='public.fleet_sources'::regclass;`,
 `create temp table source_policy_before as select polname,polcmd,pg_get_expr(polqual,polrelid) as expression from pg_policy where polrelid='public.fleet_sources'::regclass;`,
 readFileSync(new URL('../production/fleet-source-health.sql',import.meta.url),'utf8'),
 ...[admin,manager,viewer,pending].map((id,i)=>`insert into auth.users(id,email,aud,role) values(${q(id)},${q(id+'@example.invalid')},'authenticated','authenticated');update public.profiles set role=${q(['admin','manager','viewer','pending'][i])} where user_id=${q(id)};`),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic scope A','Casablanca'),(${agency+1},'Synthetic scope B','Marrakech');`,
 `insert into public.user_agencies(user_id,agency_id) values(${q(manager)},${agency}),(${q(viewer)},${agency+1});`,
 `update public.fleet_sources set status='healthy',last_success_at=now(),last_error='Synthetic private provider account',metadata='{"private_company":"hidden","motion_error":"private diagnostic"}',coverage='{"drivers":123456}' where id='geotab';`,
 ...[manager,viewer].flatMap(id=>[
  auth(id),check(`(select count(*)=4 from public.fleet_source_health())`,'validated_scoped_staff_can_read_health'),
  check(`(select count(*)=0 from public.fleet_sources)`,'source_table_stays_admin_only'),
  check(`(select status='healthy' and stale_after_s>0 and last_success_at is not null and motion_error from public.fleet_source_health() where id='geotab')`,'required_health_fields_visible'),
  check(`(select last_error='Collecte temporairement indisponible.' from public.fleet_source_health() where id='geotab')`,'provider_error_sanitized'),
  check(`(select bool_and(not(to_jsonb(h)?|array['metadata','coverage','company','vehicle_key'])) from public.fleet_source_health() h)`,'business_metadata_not_projected')
 ]),
 auth(admin),check(`(select metadata->>'private_company'='hidden' from public.fleet_sources where id='geotab')`,'old_admin_source_read_unchanged'),
 check(`(select count(*)=4 from public.fleet_source_health())`,'admin_without_membership_can_read_health'),
 owner,'set local role service_role;',
 check(`(select metadata->>'private_company'='hidden' from public.fleet_sources where id='geotab')`,'old_collector_source_read_unchanged'),
 reject('perform public.fleet_source_health()','service_role_has_no_rpc_grant'),
 owner,'set local role anon;',reject('perform public.fleet_source_health()','anon_denied'),
 reject('perform fleet_read_private.source_health()','anon_private_helper_denied'),
 auth(pending),reject('perform public.fleet_source_health()','pending_profile_denied'),
 auth(randomUUID()),reject('perform public.fleet_source_health()','missing_profile_denied'),
 owner,'set local role authenticated;',reject('perform public.fleet_source_health()','missing_subject_denied'),
 owner,`update public.profiles set role='pending' where user_id=${q(manager)};`,auth(manager),
 reject('perform public.fleet_source_health()','current_database_role_revocation_denies_existing_jwt'),
 owner,
 check(`not has_function_privilege('anon','public.fleet_source_health()','EXECUTE') and not has_function_privilege('service_role','public.fleet_source_health()','EXECUTE')`,'explicit_execute_revocations'),
 check(`(select not prosecdef from pg_proc where oid='public.fleet_source_health()'::regprocedure)`,'public_wrapper_is_invoker'),
 check(`not exists((select relacl,relrowsecurity from pg_class where oid='public.fleet_sources'::regclass) except (select * from source_acl_before))`,'table_grants_and_rls_unchanged'),
 check(`not exists((select polname,polcmd,pg_get_expr(polqual,polrelid) from pg_policy where polrelid='public.fleet_sources'::regclass) except (select * from source_policy_before)) and not exists((select * from source_policy_before) except (select polname,polcmd,pg_get_expr(polqual,polrelid) from pg_policy where polrelid='public.fleet_sources'::regclass))`,'table_policies_unchanged'),
 check(`(select value='staging' from public.params where key='environment')`,'environment_preserved'),
 'rollback;'].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(value=>value==='--username=postgres'?'--username=supabase_admin':value),{input:sql,encoding:'utf8',timeout:45000,maxBuffer:1048576,env});
if(result.error||result.status!==0){
 const directory=new URL('../.local/checks/',import.meta.url);mkdirSync(directory,{recursive:true,mode:0o700});
 const file=new URL('fleet-source-health-private-error.log',directory);writeFileSync(file,String(result.stderr),{mode:0o600});chmodSync(file,0o600);
 throw Error('Local source health rollback failed: '+(String(result.stderr).match(/fleet-source-health-test: ([a-z_0-9]+)/)?.[1]||'SQL validation; private diagnostic'));
}
assert.equal(result.stdout.trim(),'');console.log(JSON.stringify({ok:true,checks,rolledBack:true,target:'local-staging-only',oldCollectorCompatible:true,sourceTableStillAdminOnly:true}));
