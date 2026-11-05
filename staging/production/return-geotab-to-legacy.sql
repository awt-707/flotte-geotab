-- FIRST stop Geotab in Ludy and verify its polling has stopped. Keep the other
-- desktop providers running. Do not use this while any desktop collects Geotab.
-- Restores legacy live writes, association updates and vehicle deletions.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';
lock table public.vehicles, public.live_status in share row exclusive mode;
alter table public.vehicles disable trigger ludy_desktop_geotab_vehicle_guard;
alter table public.live_status disable trigger ludy_desktop_geotab_live_guard;
commit;
