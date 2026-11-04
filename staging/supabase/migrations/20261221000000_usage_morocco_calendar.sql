-- Staging only: use the Moroccan calendar instead of a fixed UTC+1 estimate.
-- The local PostgreSQL tzdata includes the permanent GMT return on 20/09/2026.
-- Existing counter rows are preserved: their original event instants are absent,
-- so an automatic historical reassignment would invent a daily distribution.
do $$ begin
 if (select value from public.params where key='environment') is distinct from 'staging'
 then raise exception 'Staging required';end if;
end $$;

create or replace function public.bump_usage(p_kind text) returns void language sql security definer set search_path = public as $$
  insert into usage_daily (day, kind, n) values ((now() at time zone 'Africa/Casablanca')::date, p_kind, 1)
  on conflict (day, kind) do update set n = usage_daily.n + 1
$$;
revoke execute on function public.bump_usage(text) from public, anon, authenticated;
grant execute on function public.bump_usage(text) to service_role;

create or replace function public.usage_stats() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare st jsonb := '{}'::jsonb; m date := date_trunc('month', now() at time zone 'Africa/Casablanca')::date;
begin
  if not (is_admin() or coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role') then
    raise exception 'réservé à l''administrateur';
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'select coalesce(jsonb_object_agg(bucket_id, mb), ''{}''::jsonb) from (select bucket_id, round(sum(coalesce((metadata->>''size'')::bigint, 0)) / 1048576.0, 1) mb
      from storage.objects group by bucket_id) x' into st;
  end if;
  return jsonb_build_object(
    'db_mb', round(pg_database_size(current_database()) / 1048576.0, 1),
    'storage_mb', st,
    'live_month', (select coalesce(sum(n), 0) from usage_daily where kind = 'live' and day >= m),
    'live_since', (select min(day) from usage_daily where kind = 'live' and day >= m),
    'live_days', (select count(*) from usage_daily where kind = 'live' and day >= m),
    'month', m);
end $$;
revoke execute on function public.usage_stats() from public, anon;
grant execute on function public.usage_stats() to authenticated, service_role;

