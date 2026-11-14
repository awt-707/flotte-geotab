-- Empreinte du schéma public (et des règles du stockage) : une ligne par objet (genre, nom, définition), pour comparer deux bases.
-- Utilisé par database/outils/schema.js check et database/outils/production.js.
with t as (select c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v','m','p','S'))
select kind, name, def from (
 select 'table'::text kind, relname::text name, relkind::text||' rls='||relrowsecurity||' force='||relforcerowsecurity def from t
 union all select 'acl', relname, coalesce((select string_agg(x::text, ',' order by x::text) from unnest(relacl) x),'') from t
 union all select 'col', t.relname||'.'||a.attname, format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' not null' else '' end||coalesce(' default '||pg_get_expr(d.adbin,d.adrelid),'')||coalesce(' acl='||(select string_agg(x::text, ',' order by x::text) from unnest(a.attacl) x),'')
   from t join pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
 union all select 'con', t.relname||'.'||co.conname, pg_get_constraintdef(co.oid) from t join pg_constraint co on co.conrelid=t.oid
 union all select 'idx', i.indexname, i.indexdef from pg_indexes i where schemaname='public'
 union all select 'view', t.relname, pg_get_viewdef(t.oid) from t where relkind in ('v','m')
 union all select 'fn', p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', md5(pg_get_functiondef(p.oid))||' secdef='||p.prosecdef||' cfg='||coalesce(array_to_string(p.proconfig,';'),'')||' acl='||coalesce((select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x),'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')
 union all select 'trg', c.relname||'.'||tg.tgname, pg_get_triggerdef(tg.oid)||' enabled='||tg.tgenabled::text from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not tg.tgisinternal
 union all select 'pol', schemaname||'.'||tablename||'.'||policyname, cmd||' roles='||array_to_string(roles,',')||' using='||coalesce(qual,'')||' check='||coalesce(with_check,'')||' perm='||permissive from pg_policies where schemaname in ('public','storage')
 union all select 'pub', pubname||'.'||schemaname||'.'||tablename, '' from pg_publication_tables where schemaname='public'
 union all select 'ext', extname, extversion from pg_extension
 union all select 'type', t2.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_type t2 join pg_namespace n on n.oid=t2.typnamespace left join pg_enum e on e.enumtypid=t2.oid where n.nspname='public' and t2.typtype in ('e','d','c') and not exists (select 1 from pg_class c where c.reltype=t2.oid) group by 1,2
) z order by 1,2
