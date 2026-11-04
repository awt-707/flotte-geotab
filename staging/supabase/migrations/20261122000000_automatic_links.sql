-- Staging only: explicit provenance and manual overrides for automatic associations.
alter table public.fleet_drivers add column link_method text;
alter table public.fleet_drivers add column link_evidence jsonb not null default '{}';
alter table public.fleet_drivers add column vehicle_link_method text;
alter table public.fleet_drivers add column vehicle_link_evidence jsonb not null default '{}';
alter table public.fleet_drivers add column auto_link_disabled boolean not null default false;
update public.fleet_drivers set link_method='manual',auto_link_disabled=true where ludy_driver_code is not null;
update public.fleet_drivers set vehicle_link_method='manual' where vehicle_key is not null;
create table public.fleet_link_audit (
  id uuid primary key default gen_random_uuid(), at timestamptz not null default now(),
  driver_id uuid references public.fleet_drivers(id) on delete set null,
  action text not null, method text not null, evidence jsonb not null default '{}'
);
alter table public.fleet_link_audit enable row level security;
revoke all on public.fleet_link_audit from anon,authenticated;
grant select on public.fleet_link_audit to authenticated;
grant all on public.fleet_link_audit to service_role;
create policy read_admin on public.fleet_link_audit for select to authenticated using(public.is_admin());

alter function public.fleet_link_driver(uuid,text,text,bigint) rename to fleet_link_driver_base;
create function public.fleet_link_driver(p_driver uuid,p_ludy_code text,p_vehicle_key text default null,p_agency_id bigint default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare target uuid;
begin
  target := public.fleet_link_driver_base(p_driver,p_ludy_code,p_vehicle_key,p_agency_id);
  update fleet_drivers set link_method='manual',auto_link_disabled=true,vehicle_link_method='manual',
    vehicle_link_evidence='{}'::jsonb,link_evidence=jsonb_build_object('at',now(),'method','manual') where id=target;
  insert into fleet_link_audit(driver_id,action,method,evidence) values(target,'associate','manual',jsonb_build_object('ludy_driver_code',p_ludy_code,'vehicle_key',p_vehicle_key));
  return target;
end $$;

create function public.fleet_auto_link_driver(p_driver uuid,p_ludy_code text,p_platform_name text,p_ludy_name text)
returns uuid language plpgsql security definer set search_path=public as $$
declare old_row fleet_drivers%rowtype; existing fleet_drivers%rowtype; target uuid; proof jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into old_row from fleet_drivers where id=p_driver for update;
  if not found then return null; end if;
  if old_row.auto_link_disabled or old_row.ludy_driver_code is not null or old_row.name is distinct from p_platform_name then return null; end if;
  if not exists(select 1 from drivers where code=p_ludy_code and name=p_ludy_name) then return null; end if;
  select * into existing from fleet_drivers where ludy_driver_code=p_ludy_code;
  proof := jsonb_build_object('method','exact_name','platform_name',p_platform_name,'ludy_name',p_ludy_name,'at',now());
  target := public.fleet_link_driver_base(p_driver,p_ludy_code,coalesce(existing.vehicle_key,old_row.vehicle_key),null);
  update fleet_drivers set link_method=coalesce(existing.link_method,'exact_name'),link_evidence=proof where id=target;
  insert into fleet_link_audit(driver_id,action,method,evidence) values(target,'associate','exact_name',proof||jsonb_build_object('previous_driver_id',p_driver,'ludy_driver_code',p_ludy_code));
  return target;
end $$;

create function public.fleet_auto_link_vehicle(p_driver uuid,p_vehicle_key text,p_evidence jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare current_row fleet_drivers%rowtype; expiry timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into current_row from fleet_drivers where id=p_driver for update;
  if not found or current_row.auto_link_disabled or current_row.ludy_driver_code is null or current_row.vehicle_link_method='manual'
    or (current_row.vehicle_key is not null and current_row.vehicle_link_method is null) then return false; end if;
  expiry := (p_evidence->>'expires_at')::timestamptz;
  if p_evidence->>'method' is distinct from 'platform_plate' or coalesce(p_evidence->>'source','') not in ('uber','bolt')
    or expiry is null or expiry<=now() or expiry>now()+interval '4 minutes' then return false; end if;
  if not exists(select 1 from vehicles where key=p_vehicle_key and active is distinct from 'NON'
    and (current_row.agency_id is null or agency_id=current_row.agency_id)) then return false; end if;
  -- A stale automatic claim cannot hold a car forever after a shift change.
  update fleet_drivers set vehicle_key=null,vehicle_link_evidence='{}'::jsonb
    where id<>p_driver and vehicle_key=p_vehicle_key and vehicle_link_method='platform_plate'
      and (vehicle_link_evidence->>'expires_at')::timestamptz<=now();
  if exists(select 1 from fleet_drivers where id<>p_driver and vehicle_key=p_vehicle_key) then return false; end if;
  if current_row.vehicle_key is distinct from p_vehicle_key then
    insert into fleet_link_audit(driver_id,action,method,evidence) values(p_driver,'vehicle','platform_plate',p_evidence||jsonb_build_object('vehicle_key',p_vehicle_key,'previous_vehicle_key',current_row.vehicle_key));
  end if;
  update fleet_drivers set vehicle_key=p_vehicle_key,vehicle_link_method='platform_plate',vehicle_link_evidence=p_evidence where id=p_driver;
  return true;
end $$;

revoke all on function public.fleet_link_driver(uuid,text,text,bigint),public.fleet_auto_link_driver(uuid,text,text,text),public.fleet_auto_link_vehicle(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.fleet_link_driver(uuid,text,text,bigint),public.fleet_auto_link_driver(uuid,text,text,text),public.fleet_auto_link_vehicle(uuid,text,jsonb) to service_role;
