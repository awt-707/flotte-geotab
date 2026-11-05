-- Additive observer API, generated from a separate reviewed migration skeleton.
-- Apply as schema owner in a transaction BEFORE desktop 0.2.8. Old collectors
-- keep using fleet_sources unchanged. Its table grants and RLS stay unchanged.
-- Health is workspace-wide technical state; agency business data is not read.
create schema fleet_read_private;
revoke all on schema fleet_read_private from public,anon,authenticated,service_role;
grant usage on schema fleet_read_private to authenticated;

create function fleet_read_private.source_health()
returns table(id text,name text,status text,last_success_at timestamptz,
 last_error text,stale_after_s integer,motion_error boolean)
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid();staff_role text;
begin
 if actor is null then
  raise exception using errcode='42501',message='Staff session required';
 end if;
 select p.role into staff_role from public.profiles p where p.user_id=actor;
 if coalesce(staff_role,'') not in('admin','manager','viewer') then
  raise exception using errcode='42501',message='Validated staff required';
 end if;
 -- Fixed source allowlist and projection: never expose provider errors,
 -- company metadata, credentials, counts, coverage or vehicle identifiers.
 return query
 select s.id,case s.id when 'uber' then 'Uber' when 'bolt' then 'Bolt'
  when 'geotab' then 'Geotab' when 'myclicar' then 'MyClicar' end,
  s.status,s.last_success_at,
  case when s.last_error is not null then 'Collecte temporairement indisponible.'::text end,
  s.stale_after_s,
  coalesce(s.metadata->>'motion_error','') not in('','false')
 from public.fleet_sources s
 where s.id in('uber','bolt','geotab','myclicar')
 order by s.id;
end $$;
revoke all on function fleet_read_private.source_health() from public,anon,authenticated,service_role;
grant execute on function fleet_read_private.source_health() to authenticated;

-- The exposed entry point carries no elevated privileges. The private helper
-- is callable only by authenticated and checks the current DB profile itself.
create function public.fleet_source_health()
returns table(id text,name text,status text,last_success_at timestamptz,
 last_error text,stale_after_s integer,motion_error boolean)
language sql stable security invoker set search_path='' as $$
 select * from fleet_read_private.source_health()
$$;
revoke all on function public.fleet_source_health() from public,anon,authenticated,service_role;
grant execute on function public.fleet_source_health() to authenticated;
