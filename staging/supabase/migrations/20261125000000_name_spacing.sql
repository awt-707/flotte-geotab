-- Staging only: exact letters in original order, allowing spaces/hyphens only.
-- This is not phonetic or approximate matching and never assigns a car by name.
create function public.fleet_spaced_name_key(p_name text) returns text
language sql immutable set search_path=public as $$
  select regexp_replace(lower(coalesce(p_name,'')), '[[:space:]-]+', '', 'g')
$$;
create function public.fleet_auto_link_driver_spacing(p_driver uuid,p_ludy_code text,p_platform_name text,p_ludy_name text)
returns uuid language plpgsql security definer set search_path=public as $$
declare old_row fleet_drivers%rowtype; ref_row drivers%rowtype; existing fleet_drivers%rowtype; target uuid; k text; proof jsonb;
begin
  if (select value from params where key='environment') is distinct from 'staging' then raise exception 'Base locale de staging obligatoire'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into old_row from fleet_drivers where id=p_driver for update;
  if not found or old_row.auto_link_disabled or old_row.ludy_driver_code is not null or old_row.name is distinct from p_platform_name then return null; end if;
  select * into ref_row from drivers where code=p_ludy_code and name=p_ludy_name;
  if not found then return null; end if;
  k:=fleet_spaced_name_key(old_row.name);
  if length(k)<8 or k!~'^[[:alpha:]]+$' or k is distinct from fleet_spaced_name_key(ref_row.name)
    or old_row.name!~'[[:alpha:]][[:space:]-]+[[:alpha:]]' or ref_row.name!~'[[:alpha:]][[:space:]-]+[[:alpha:]]'
    or (select count(*) from drivers where fleet_spaced_name_key(name)=k)<>1
    or old_row.agency_id is not null and ref_row.agency_id is distinct from old_row.agency_id then return null; end if;
  if exists(select 1 from fleet_identities own join fleet_identities other
      on own.source=other.source and own.organization_id is not distinct from other.organization_id and own.driver_id<>other.driver_id
      join fleet_drivers d on d.id=other.driver_id where own.driver_id=p_driver and fleet_spaced_name_key(d.name)=k) then return null; end if;
  select * into existing from fleet_drivers where ludy_driver_code=p_ludy_code;
  target:=fleet_link_driver_base(p_driver,p_ludy_code,coalesce(existing.vehicle_key,old_row.vehicle_key),null);
  proof:=jsonb_build_object('method','name_spacing','platform_name',p_platform_name,'ludy_name',p_ludy_name,'at',now());
  update fleet_drivers set link_method=coalesce(existing.link_method,'name_spacing'),link_evidence=proof where id=target;
  insert into fleet_link_audit(driver_id,action,method,evidence) values(target,'associate','name_spacing',proof||jsonb_build_object('previous_driver_id',p_driver,'ludy_driver_code',p_ludy_code));
  return target;
end $$;
revoke all on function public.fleet_spaced_name_key(text),public.fleet_auto_link_driver_spacing(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.fleet_spaced_name_key(text),public.fleet_auto_link_driver_spacing(uuid,text,text,text) to service_role;
