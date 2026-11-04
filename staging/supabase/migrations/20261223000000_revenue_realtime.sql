-- Staging only. Publish agency refresh markers, never financial rows or keys.
-- DELETE changes do not apply row-level security in Supabase Realtime:
-- https://supabase.com/docs/guides/realtime/postgres-changes#delete-events
-- Markers are only inserted/updated, with no name, plate or monetary payload.
do $$
begin
  if (select value from public.params where key='environment') is distinct from 'staging'
  then raise exception 'Staging required'; end if;
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
    raise exception 'Publication supabase_realtime required';
  end if;
  if exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename in ('uber_payments', 'bolt_sessions', 'cash_moves')
  ) then
    raise exception 'Financial rows must not be published; review existing memberships separately';
  end if;
end $$;

-- No FK: deleting an agency must never cascade a marker DELETE. Zero is the
-- admin-only marker for financial rows without an agency, never a manager scope.
create table if not exists public.revenue_refresh (
  agency_id bigint primary key check (agency_id >= 0),
  version bigint not null default 1 check (version > 0),
  touched_at timestamptz not null default now()
);
alter table public.revenue_refresh enable row level security;
revoke all on public.revenue_refresh from public, anon, authenticated, service_role;
grant select on public.revenue_refresh to authenticated;
drop policy if exists revenue_refresh_read on public.revenue_refresh;
create policy revenue_refresh_read on public.revenue_refresh for select to authenticated
  using ((select public.is_admin()) or
    (agency_id > 0 and public.my_role()='manager' and agency_id=any((select public.my_agency_ids())::bigint[])));

create or replace function public.revenue_refresh_after_statement()
returns trigger language plpgsql security definer set search_path = '' as $$
declare affected_agencies bigint[]; affected_agency bigint;
begin
  if tg_table_schema <> 'public' or tg_table_name not in ('uber_payments', 'bolt_sessions', 'cash_moves')
    or tg_op not in ('INSERT', 'UPDATE', 'DELETE') then
    raise exception 'Financial statement trigger required';
  end if;
  -- Transition tables are statement-local PostgreSQL relations, not public data
  -- resolved through a caller-controlled search path. One bump per agency per
  -- statement avoids serializing every row of a large CSV import on the marker.
  if tg_op='INSERT' then
    select array_agg(s.agency_id order by s.agency_id) into affected_agencies
      from (select distinct coalesce(r.agency_id,0) agency_id from new_revenue_rows r) s;
  elsif tg_op='DELETE' then
    select array_agg(s.agency_id order by s.agency_id) into affected_agencies
      from (select distinct coalesce(r.agency_id,0) agency_id from old_revenue_rows r) s;
  else
    select array_agg(s.agency_id order by s.agency_id) into affected_agencies
      from (select coalesce(r.agency_id,0) agency_id from old_revenue_rows r
        union select coalesce(r.agency_id,0) agency_id from new_revenue_rows r) s;
  end if;
  -- Sorting OLD/NEW scopes gives concurrent agency transfers the same lock order.
  foreach affected_agency in array coalesce(affected_agencies,array[]::bigint[]) loop
    insert into public.revenue_refresh(agency_id,version,touched_at)
      values(affected_agency,1,pg_catalog.clock_timestamp())
    on conflict(agency_id) do update
      set version=public.revenue_refresh.version+1,touched_at=pg_catalog.clock_timestamp();
  end loop;
  return null;
end $$;
revoke all on function public.revenue_refresh_after_statement() from public, anon, authenticated, service_role;

do $$
declare table_name text; rls_enabled boolean;
begin
  if (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
      where a.attrelid='public.revenue_refresh'::regclass and a.attnum>0 and not a.attisdropped)
      is distinct from array['agency_id','version','touched_at']
    or (select array_agg(a.atttypid order by a.attnum) from pg_attribute a
      where a.attrelid='public.revenue_refresh'::regclass and a.attnum>0 and not a.attisdropped)
      is distinct from array['bigint'::regtype::oid,'bigint'::regtype::oid,'timestamptz'::regtype::oid]
    or not exists (select 1 from pg_constraint where conrelid='public.revenue_refresh'::regclass
      and contype='p' and conkey=array[1]::smallint[])
    or exists (select 1 from pg_constraint where conrelid='public.revenue_refresh'::regclass and contype='f')
    or exists (select 1 from pg_policy where polrelid='public.revenue_refresh'::regclass and polname<>'revenue_refresh_read')
    or (select relreplident from pg_class where oid='public.revenue_refresh'::regclass) <> 'd' then
    raise exception 'Refresh marker schema or policy drift requires review';
  end if;
  foreach table_name in array array['uber_payments', 'bolt_sessions', 'cash_moves'] loop
    select c.relrowsecurity into rls_enabled
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=table_name and c.relkind='r';
    if rls_enabled is distinct from true then
      raise exception 'Financial table public.% must exist with row level security enabled', table_name;
    end if;
    execute format('drop trigger if exists revenue_refresh_insert on public.%I',table_name);
    execute format('drop trigger if exists revenue_refresh_update on public.%I',table_name);
    execute format('drop trigger if exists revenue_refresh_delete on public.%I',table_name);
    execute format('create trigger revenue_refresh_insert after insert on public.%I referencing new table as new_revenue_rows for each statement execute function public.revenue_refresh_after_statement()',table_name);
    execute format('create trigger revenue_refresh_update after update on public.%I referencing old table as old_revenue_rows new table as new_revenue_rows for each statement execute function public.revenue_refresh_after_statement()',table_name);
    execute format('create trigger revenue_refresh_delete after delete on public.%I referencing old table as old_revenue_rows for each statement execute function public.revenue_refresh_after_statement()',table_name);
  end loop;
  if not exists (
    select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='revenue_refresh'
  ) then
    alter publication supabase_realtime add table public.revenue_refresh;
  end if;
end $$;
