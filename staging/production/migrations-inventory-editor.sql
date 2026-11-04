-- Read-only metadata inventory. Run only after confirming the intended project.
-- No application rows, Auth accounts, Storage objects, function bodies or job commands are returned.
-- SQL Editor variant: the final query returns one inventory_json cell.
-- The metadata snapshot is READ ONLY; a temporary session setting carries the
-- result across COMMIT and is cleared before the result row is returned.
-- This file does not prove a backup exists and does not authorize migration execution.
begin transaction isolation level repeatable read read only;
set local search_path = pg_catalog;
set local statement_timeout = '15s';
set local lock_timeout = '1s';
set local idle_in_transaction_session_timeout = '30s';
set local client_min_messages = 'notice';

do $inventory$
declare
  history_available boolean := to_regclass('supabase_migrations.schema_migrations') is not null;
  versions jsonb := '[]'::jsonb;
  catalogs jsonb;
  result jsonb;
begin
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'Read-only transaction required';
  end if;
  if history_available then
    -- Only migration version identifiers, never statement bodies or row contents.
    execute 'select coalesce(jsonb_agg(version::text order by version::text), ''[]''::jsonb) from supabase_migrations.schema_migrations'
      into versions;
    if jsonb_array_length(versions) > 10000 then raise exception 'Migration history exceeds inventory bound';end if;
  end if;

  select jsonb_build_object(
    'relations', coalesce((select jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'name', c.relname, 'kind', c.relkind,
      'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity,
      'owner', pg_get_userbyid(c.relowner), 'acl', c.relacl::text,
      'columns', coalesce((select jsonb_agg(jsonb_build_object(
        'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull,
        'identity', a.attidentity, 'generated', a.attgenerated,
        'defaultMd5', md5(coalesce(pg_get_expr(d.adbin, d.adrelid), ''))
      ) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped), '[]'::jsonb),
      'constraints', coalesce((select jsonb_agg(jsonb_build_object(
        'name', k.conname, 'type', k.contype, 'validated', k.convalidated,
        'definitionMd5', md5(pg_get_constraintdef(k.oid, true))
      ) order by k.conname) from pg_constraint k where k.conrelid=c.oid), '[]'::jsonb)
    ) order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','auth','storage') and c.relkind in ('r','p','v','m','S')), '[]'::jsonb),
    'functions', coalesce((select jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'name', p.proname, 'identityArguments', pg_get_function_identity_arguments(p.oid),
      'result', pg_get_function_result(p.oid), 'securityDefiner', p.prosecdef,
      'owner', pg_get_userbyid(p.proowner), 'acl', p.proacl::text,
      'definitionMd5', md5(pg_get_functiondef(p.oid))
    ) order by p.proname,pg_get_function_identity_arguments(p.oid))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind in ('f','p')), '[]'::jsonb),
    'policies', coalesce((select jsonb_agg(jsonb_build_object(
      'schema', schemaname, 'table', tablename, 'name', policyname,
      'roles', roles, 'command', cmd, 'permissive', permissive,
      'usingMd5', md5(coalesce(qual,'')), 'checkMd5', md5(coalesce(with_check,''))
    ) order by schemaname,tablename,policyname) from pg_policies
      where schemaname in ('public','storage')), '[]'::jsonb),
    'triggers', coalesce((select jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'table', c.relname, 'name', t.tgname, 'enabled', t.tgenabled,
      'function', t.tgfoid::regprocedure::text, 'definitionMd5', md5(pg_get_triggerdef(t.oid,true))
    ) order by n.nspname,c.relname,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
      where not t.tgisinternal and n.nspname in ('public','auth','storage')), '[]'::jsonb),
    'indexes', coalesce((select jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'table', c.relname, 'name', ix.relname, 'valid', i.indisvalid,
      'unique', i.indisunique, 'definitionMd5', md5(pg_get_indexdef(ix.oid))
    ) order by n.nspname,c.relname,ix.relname) from pg_index i join pg_class c on c.oid=i.indrelid
      join pg_class ix on ix.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','auth','storage')), '[]'::jsonb),
    'publications', coalesce((select jsonb_agg(jsonb_build_object(
      'name', pubname, 'schema', schemaname, 'table', tablename
    ) order by pubname,schemaname,tablename) from pg_publication_tables
      where schemaname='public'), '[]'::jsonb),
    'extensions', coalesce((select jsonb_agg(jsonb_build_object(
      'name', extname, 'version', extversion
    ) order by extname) from pg_extension), '[]'::jsonb)
  ) into catalogs;

  result := jsonb_build_object(
    'format', 'ludy-production-metadata-v1', 'transactionReadOnly', true,
    'capturedAt', transaction_timestamp(), 'database', current_database(),
    'serverVersion', current_setting('server_version'),
    'history', jsonb_build_object('available', history_available, 'versions', versions),
    'catalogs', catalogs,
    'omitted', jsonb_build_array('business rows','Auth users and credentials','Storage objects and bucket configuration',
      'function/policy/trigger bodies','scheduled job commands','Edge Functions','Apps Script','API keys','backups')
  );
  perform set_config('ludy_inventory_editor.result', result::text, false);
end $inventory$;
commit;

-- The editor displays the last statement's rows. Both CTEs are materialized and
-- clearing depends on capture, so cleanup cannot run before the JSON is read.
-- This final statement reads session state only, never application tables.
with captured as materialized (
  select nullif(current_setting('ludy_inventory_editor.result', true), '')::jsonb as inventory_json
), cleared as materialized (
  select set_config('ludy_inventory_editor.result', '', false) as state from captured
)
select captured.inventory_json
from captured cross join cleared
where captured.inventory_json is not null and cleared.state='';
