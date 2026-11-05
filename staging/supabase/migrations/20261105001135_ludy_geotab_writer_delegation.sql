-- Install only. Both guards remain DISABLED until the operator hands live
-- Geotab ownership to the desktop in a separate, atomic transaction.
-- The existing Apps Script release, historical reads and other services stay
-- intact. Disabling only these two named triggers restores legacy ownership.
-- Run in a migration transaction so these limits apply before the DO starts.
set local lock_timeout = '5s';
set local statement_timeout = '20s';
do $install$
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);

  -- This order is also used by activation and rollback.
  lock table public.vehicles, public.live_status in share row exclusive mode;

  create function public.ludy_desktop_geotab_legacy_guard()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog
  as $guard$
  declare
    caller_role text := coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claim', true), '')::jsonb ->> 'role',
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    );
  begin
    -- SECURITY DEFINER desktop RPCs run as postgres but retain the verified
    -- authenticated JWT. current_user would therefore identify the wrong actor.
    -- Administrative SQL with no request JWT is unaffected.
    if caller_role is distinct from 'service_role' then
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end if;

    if tg_table_schema = 'public' and tg_table_name = 'live_status' then
      -- Ignore the old collector's positions and snapshot cleanup atomically.
      return null;
    elsif tg_table_schema = 'public' and tg_table_name = 'vehicles' then
      -- Legacy whole-table refreshes must not delete desktop associations or
      -- cascade into desktop snapshots. These legacy deletions are deferred
      -- until ownership is explicitly returned to the legacy collector.
      if tg_op = 'DELETE' then return null; end if;
      if tg_op = 'UPDATE' then
        new.geotab_id := old.geotab_id;
        new.geotab_name := old.geotab_name;
      else
        new.geotab_id := null;
        new.geotab_name := null;
      end if;
      return new;
    end if;

    raise exception 'Unexpected table for the Geotab legacy writer guard';
  end
  $guard$;

  revoke all on function public.ludy_desktop_geotab_legacy_guard()
    from public, anon, authenticated, service_role;

  create trigger ludy_desktop_geotab_vehicle_guard
    before insert or update or delete on public.vehicles
    for each row execute function public.ludy_desktop_geotab_legacy_guard();
  alter table public.vehicles disable trigger ludy_desktop_geotab_vehicle_guard;

  create trigger ludy_desktop_geotab_live_guard
    before insert or update or delete on public.live_status
    for each row execute function public.ludy_desktop_geotab_legacy_guard();
  alter table public.live_status disable trigger ludy_desktop_geotab_live_guard;
end
$install$;
