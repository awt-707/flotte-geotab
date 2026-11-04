-- Staging only. Match the separate platform-state and vehicle-detail clocks.
-- Reading a fresh status must not refresh an older selected vehicle's proof.
create function public.fleet_vehicle_observation_current(
  p_source text,
  p_status text,
  p_observed_at timestamptz,
  p_evidence jsonb,
  p_source_status text,
  p_success_at timestamptz,
  p_stale_after_s integer
) returns boolean language plpgsql stable set search_path=public as $$
declare vehicle_at timestamptz; vehicle_ttl integer;
begin
  if p_source_status is distinct from 'healthy'
    or p_status is null or p_status not in ('available','on_trip','to_pickup','on_break')
    or p_observed_at is null or not isfinite(p_observed_at)
    or p_success_at is null or not isfinite(p_success_at)
    or p_stale_after_s is null or p_stale_after_s<=0
    or p_observed_at>now()+interval '5 seconds'
    or p_observed_at<now()-make_interval(secs=>p_stale_after_s)
    or p_success_at>now()+interval '5 seconds'
    or p_success_at<now()-make_interval(secs=>p_stale_after_s)
    or coalesce(p_evidence->>'account_status','') in ('suspended','deactivated') then
    return false;
  end if;

  vehicle_at:=p_observed_at;
  vehicle_ttl:=least(p_stale_after_s,180);
  if p_source='uber' then
    if coalesce(nullif(p_evidence->>'method',''),'visible_dom')<>'visible_dom'
      or (p_evidence->>'vehicle_status' is not null
        and p_evidence->>'vehicle_status' not in ('available','on_trip','to_pickup','on_break')) then
      return false;
    end if;
    if p_evidence->>'vehicle_observed_at' is not null then
      if jsonb_typeof(p_evidence->'vehicle_observed_at') is distinct from 'string' then return false; end if;
      begin
        vehicle_at:=(p_evidence->>'vehicle_observed_at')::timestamptz;
      exception when invalid_datetime_format or datetime_field_overflow then
        return false;
      end;
      vehicle_ttl:=180;
    end if;
  elsif p_source='bolt' then
    if p_evidence->>'method' is distinct from 'official_api'
      or p_evidence->>'vehicle_origin' is distinct from 'bolt_live' then return false; end if;
  else
    return false;
  end if;

  return isfinite(vehicle_at) and vehicle_at<=p_observed_at
    and vehicle_at+make_interval(secs=>vehicle_ttl)>now();
end $$;

create or replace function public.fleet_auto_link_myclicar_vehicle(p_driver uuid,p_contract_id text)
returns boolean language plpgsql security definer set search_path=public as $$
declare
  d public.fleet_drivers%rowtype;
  c public.fleet_myclicar_contracts%rowtype;
  s public.fleet_sources%rowtype;
  expiry timestamptz;
  proof jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into d from public.fleet_drivers where id=p_driver for update;
  if not found or d.auto_link_disabled or d.ludy_driver_code is null or d.vehicle_link_method='manual'
    or d.vehicle_key is not null and d.vehicle_link_method is null then return false; end if;
  select * into c from public.fleet_myclicar_contracts where external_id=p_contract_id;
  if not found or not c.current or not c.eligible or c.client_code is distinct from d.ludy_driver_code
    or c.status<>'IN_PROGRESS' or c.deleted or c.end_at is not null
    or c.effective_start_at is null or c.effective_start_at>now()
    or c.observed_at>now()+interval '5 seconds' then return false; end if;
  select * into s from public.fleet_sources where id='myclicar';
  if s.status is distinct from 'healthy' or s.last_success_at is null
    or s.last_success_at>now()+interval '5 seconds' then return false; end if;
  expiry:=least(c.observed_at,s.last_success_at)+make_interval(secs=>least(s.stale_after_s,300));
  if expiry<=now() then return false; end if;
  if not exists(
    select 1 from public.vehicles v join public.drivers r on r.code=d.ludy_driver_code
    where v.key=c.vehicle_key and upper(coalesce(v.active,'OUI'))<>'NON'
      and (r.agency_id is null or r.agency_id=v.agency_id)
      and (d.agency_id is null or d.agency_id=v.agency_id)
  ) then return false; end if;
  if exists(
    select 1 from public.fleet_myclicar_contracts other
    where other.current and other.external_id<>c.external_id and other.status='IN_PROGRESS'
      and not other.deleted and other.end_at is null and other.effective_start_at<=now()
      and (other.client_code=c.client_code or c.vehicle_key=any(other.vehicle_candidates))
  ) then return false; end if;

  -- Only a recent online vehicle observation can contradict the current contract.
  -- Uber details may be cached for 180 s, but the status/source must stay fresh.
  if exists(
    select 1 from public.fleet_latest l join public.fleet_sources src on src.id=l.source
    where l.driver_id=d.id and coalesce(l.vehicle_label,'')<>''
      and public.fleet_vehicle_observation_current(
        l.source,l.status,l.observed_at,l.evidence,src.status,src.last_success_at,src.stale_after_s
      )
      and not exists(
        select 1 from public.vehicles v,
          unnest(array[v.key,v.plate]||regexp_split_to_array(coalesce(v.other_plates,''),'[,;]')) alias
        where v.key=c.vehicle_key
          and public.fleet_myclicar_plate(alias)=public.fleet_myclicar_plate(l.vehicle_label)
      )
  ) then return false; end if;

  update public.fleet_drivers set vehicle_key=null,vehicle_link_evidence='{}'
    where id<>p_driver and vehicle_key=c.vehicle_key
      and vehicle_link_method in ('platform_plate','myclicar_contract') and not auto_link_disabled
      and coalesce((vehicle_link_evidence->>'expires_at')::timestamptz,'-infinity'::timestamptz)<=now();
  if exists(select 1 from public.fleet_drivers where id<>p_driver and vehicle_key=c.vehicle_key) then return false; end if;
  proof:=jsonb_build_object(
    'method','myclicar_contract','source','myclicar','contract_id',c.external_id,'contract_num',c.num,
    'client_code',c.client_code,'vehicle_key',c.vehicle_key,'observed_at',c.observed_at,'expires_at',expiry
  );
  if d.vehicle_key is distinct from c.vehicle_key or d.vehicle_link_method is distinct from 'myclicar_contract'
    or d.vehicle_link_evidence->>'contract_id' is distinct from c.external_id then
    insert into public.fleet_link_audit(driver_id,action,method,evidence)
      values(p_driver,'vehicle','myclicar_contract',proof||jsonb_build_object('previous_vehicle_key',d.vehicle_key));
  end if;
  update public.fleet_drivers
    set vehicle_key=c.vehicle_key,vehicle_link_method='myclicar_contract',vehicle_link_evidence=proof
    where id=p_driver;
  return true;
end $$;

revoke all on function public.fleet_vehicle_observation_current(text,text,timestamptz,jsonb,text,timestamptz,integer),
  public.fleet_auto_link_myclicar_vehicle(uuid,text) from public,anon,authenticated;
grant execute on function public.fleet_vehicle_observation_current(text,text,timestamptz,jsonb,text,timestamptz,integer),
  public.fleet_auto_link_myclicar_vehicle(uuid,text) to service_role;
