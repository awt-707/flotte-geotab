-- Local staging: internal observations only. No jobs or external writes.
create table public.fleet_motion_alerts (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.fleet_drivers(id) on delete cascade,
  identity_id uuid not null references public.fleet_identities(id) on delete cascade,
  vehicle_key text not null references public.vehicles(key) on delete cascade,
  source text not null references public.fleet_sources(id) check(source in ('uber','bolt')),
  kind text not null default 'offline_movement' check(kind='offline_movement'),
  severity text not null default 'critical' check(severity='critical'),
  status text not null default 'open' check(status in ('open','resolved','suspended')),
  observed_since timestamptz not null, opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(), resolved_at timestamptz,
  distance_m numeric not null check(distance_m>200), threshold_m integer not null default 200 check(threshold_m=200),
  evidence jsonb not null default '{}',
  unique(identity_id,vehicle_key,observed_since)
);
create index fleet_motion_alerts_recent on public.fleet_motion_alerts(opened_at desc);
alter table public.fleet_motion_alerts enable row level security;
revoke all on public.fleet_motion_alerts from anon,authenticated;
grant select on public.fleet_motion_alerts to authenticated;
grant all on public.fleet_motion_alerts to service_role;
create policy read_scope on public.fleet_motion_alerts for select to authenticated
  using(public.fleet_can_read(driver_id) and (public.is_admin() or vehicle_key=any(public.my_vehicle_keys())));

-- Keep identity merges atomic and preserve movement incident history.
-- NULL explicitly removes an assignment; callers retain the current value if omitted.
create or replace function public.fleet_link_driver(
  p_driver uuid, p_ludy_code text, p_vehicle_key text default null, p_agency_id bigint default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare old_row fleet_drivers%rowtype; target uuid; base_driver drivers%rowtype; linked_agency bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into old_row from fleet_drivers where id=p_driver for update;
  if not found then raise exception 'Chauffeur local introuvable'; end if;
  if p_ludy_code is not null then
    select * into base_driver from drivers where code=p_ludy_code;
    if not found then raise exception 'Chauffeur Ludy introuvable'; end if;
    linked_agency := base_driver.agency_id;
    select id into target from fleet_drivers where ludy_driver_code=p_ludy_code for update;
  else linked_agency := coalesce(p_agency_id,old_row.agency_id);
  end if;
  target := coalesce(target,p_driver);
  if p_vehicle_key is not null then
    if not exists(select 1 from vehicles where key=p_vehicle_key and (linked_agency is null or agency_id=linked_agency)) then
      raise exception 'Véhicule absent ou agence différente';
    end if;
    if exists(select 1 from fleet_drivers where vehicle_key=p_vehicle_key and id not in (p_driver,target)) then
      raise exception 'Véhicule déjà affecté à un autre chauffeur';
    end if;
  end if;
  if target <> p_driver then
    update fleet_identities set driver_id=target where driver_id=p_driver;
    update fleet_observations set driver_id=target where driver_id=p_driver;
    update fleet_latest set driver_id=target where driver_id=p_driver;
    update fleet_alerts set driver_id=target where driver_id=p_driver;
    update fleet_motion_alerts set driver_id=target where driver_id=p_driver;
    update fleet_rides set driver_id=target where driver_id=p_driver;
    delete from fleet_drivers where id=p_driver;
  end if;
  update fleet_drivers set ludy_driver_code=p_ludy_code,agency_id=linked_agency,
    name=case when p_ludy_code is not null then coalesce(base_driver.name,name) else name end,
    vehicle_key=p_vehicle_key where id=target;
  return target;
end $$;
revoke all on function public.fleet_link_driver(uuid,text,text,bigint) from public,anon,authenticated;
grant execute on function public.fleet_link_driver(uuid,text,text,bigint) to service_role;
