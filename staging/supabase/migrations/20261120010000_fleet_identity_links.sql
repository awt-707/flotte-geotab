-- Local staging: explicit identity association, never inferred from a name.
create unique index fleet_one_ludy_driver on public.fleet_drivers(ludy_driver_code) where ludy_driver_code is not null;
create or replace function public.fleet_link_driver(
  p_driver uuid, p_ludy_code text, p_vehicle_key text default null, p_agency_id bigint default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare old_row fleet_drivers%rowtype; target uuid; base_driver drivers%rowtype; linked_agency bigint;
begin
  if p_ludy_code is not null then
    perform pg_advisory_xact_lock(hashtextextended('fleet-link:' || p_ludy_code,0));
  end if;
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
  end if;
  if target <> p_driver then
    -- Preserve all identity IDs, observations, latest samples and incidents atomically.
    update fleet_identities set driver_id=target where driver_id=p_driver;
    update fleet_observations set driver_id=target where driver_id=p_driver;
    update fleet_latest set driver_id=target where driver_id=p_driver;
    update fleet_alerts set driver_id=target where driver_id=p_driver;
    update fleet_rides set driver_id=target where driver_id=p_driver;
    delete from fleet_drivers where id=p_driver;
  end if;
  update fleet_drivers set ludy_driver_code=p_ludy_code,agency_id=linked_agency,
    name=case when p_ludy_code is not null then coalesce(base_driver.name,name) else name end,
    vehicle_key=coalesce(p_vehicle_key,vehicle_key)
    where id=target;
  return target;
end $$;
revoke all on function public.fleet_link_driver(uuid,text,text,bigint) from public,anon,authenticated;
grant execute on function public.fleet_link_driver(uuid,text,text,bigint) to service_role;
