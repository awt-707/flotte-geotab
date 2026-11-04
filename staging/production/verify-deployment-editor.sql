-- Read-only installation check for the reviewed Ludy desktop migration.
-- Returns one final SQL Editor row. No accounts, business rows or secrets are
-- returned; only params.environment is read, and its value is not displayed.
-- A successful result verifies schema presence and grants, not user workflows,
-- provider configuration, backup restoration or collector cutover.
begin transaction isolation level repeatable read read only;
set local search_path=pg_catalog;
set local statement_timeout='10s';
set local lock_timeout='1s';
do $verify_deployment$
declare environment text;tables jsonb;rpcs jsonb;private_isolated boolean;result jsonb;checks_ok boolean;
begin
 if current_setting('transaction_read_only')<>'on' then raise exception 'Read-only transaction required';end if;
 if to_regclass('public.params') is not null and
   (select count(*) from pg_attribute where attrelid=to_regclass('public.params') and attname in('key','value') and not attisdropped)=2 then
  execute 'select value from public.params where key=''environment''' into environment;
 end if;
 select jsonb_agg(jsonb_build_object('name',required.name,'present',c.oid is not null,
  'rls',coalesce(c.relrowsecurity,false),'permissionsOk',coalesce(
   not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   and not has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   and case when required.name='public.desktop_vehicle_live' then
    has_table_privilege('authenticated',c.oid,'SELECT')
    and not has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    and exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='read_vehicle' and p.polcmd='r'
      and p.polroles=array[(select oid from pg_roles where rolname='authenticated')])
   else not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    and not exists(select 1 from pg_policy p where p.polrelid=c.oid) end,false)) order by required.name)
 into tables from (values('public.desktop_worker_devices'),('public.desktop_worker_leases'),('public.desktop_vehicle_live')) required(name)
 left join pg_class c on c.oid=to_regclass(required.name) and c.relkind='r';

 select jsonb_agg(jsonb_build_object('signature',required.signature,'present',p.oid is not null,
  'securityDefiner',coalesce(p.prosecdef,false),'permissionsOk',coalesce(
    has_function_privilege('authenticated',p.oid,'EXECUTE')
    and not has_function_privilege('anon',p.oid,'EXECUTE')
    and not has_function_privilege('service_role',p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where a.grantee=0 and a.privilege_type='EXECUTE'),false)) order by required.signature)
 into rpcs from (values
  ('public.desktop_worker_register(uuid,text,boolean)'),('public.desktop_worker_status(uuid)'),
  ('public.desktop_worker_claim(uuid)'),('public.desktop_worker_renew(uuid,bigint)'),
  ('public.desktop_worker_release(uuid,bigint)'),('public.desktop_worker_request(uuid,bigint,text,text,jsonb,jsonb,text)'),
  ('public.desktop_admin_request(uuid,text,text,jsonb,jsonb,text)'),('public.desktop_manager_request(text,text,jsonb,jsonb,text)')
 ) required(signature) left join pg_proc p on p.oid=to_regprocedure(required.signature);

 select coalesce(not has_schema_privilege('anon',n.oid,'USAGE')
  and not has_schema_privilege('authenticated',n.oid,'USAGE')
  and not has_schema_privilege('service_role',n.oid,'USAGE'),false)
 into private_isolated from pg_namespace n where n.nspname='desktop_worker_private';
 checks_ok:=coalesce(environment='production',false) and coalesce(private_isolated,false)
  and not exists(select 1 from jsonb_array_elements(tables) x
    where x->>'present'<>'true' or x->>'rls'<>'true' or x->>'permissionsOk'<>'true')
  and not exists(select 1 from jsonb_array_elements(rpcs) x
    where x->>'present'<>'true' or x->>'securityDefiner'<>'true' or x->>'permissionsOk'<>'true');
 result:=jsonb_build_object('ok',checks_ok,'scope','schema-and-permissions-only','checks',jsonb_build_object(
  'readOnly',true,'environmentProduction',coalesce(environment='production',false),
  'desktopTables',tables,'desktopRpcs',rpcs,'privateSchemaIsolated',coalesce(private_isolated,false)));
 perform set_config('ludy_deployment_verification.result',result::text,false);
end $verify_deployment$;
commit;

with captured as materialized (
 select nullif(current_setting('ludy_deployment_verification.result',true),'')::jsonb as result
), cleared as materialized (
 select set_config('ludy_deployment_verification.result','',false) as state from captured
)
select (captured.result->>'ok')::boolean as ok,captured.result->'checks' as checks
from captured cross join cleared where captured.result is not null and cleared.state='';
