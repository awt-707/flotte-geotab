-- Run only after installing the disabled guard migration and verifying the
-- desktop credentials/catalogue. The desktop connector must still be paused.
-- No business rows are changed. Existing legacy writes finish before the lock
-- is granted; subsequent service_role writes are filtered by the guards.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';
lock table public.vehicles, public.live_status in share row exclusive mode;
alter table public.vehicles enable trigger ludy_desktop_geotab_vehicle_guard;
alter table public.live_status enable trigger ludy_desktop_geotab_live_guard;
commit;
