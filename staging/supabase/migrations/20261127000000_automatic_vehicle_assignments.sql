-- Local staging only. Current platform observations supersede commercial
-- contract assignments without changing, closing or deleting those contracts.
create table public.fleet_contract_assignment_overrides (
  contract_id text primary key references public.fleet_myclicar_contracts(external_id) on delete cascade,
  client_code text not null,
  vehicle_key text not null,
  effective_start_at timestamptz not null,
  observed_at timestamptz not null,
  evidence jsonb not null default '{}'
);
alter table public.fleet_contract_assignment_overrides enable row level security;
revoke all on public.fleet_contract_assignment_overrides from public,anon,authenticated;
grant select on public.fleet_contract_assignment_overrides to authenticated;
grant all on public.fleet_contract_assignment_overrides to service_role;
create policy read_admin on public.fleet_contract_assignment_overrides for select to authenticated using(public.is_admin());

-- Private helper. Keep unrecognized/ambiguous plates as empty/multiple candidates
-- so a contradictory second platform cannot silently disappear from validation.
create function public.fleet_current_vehicle_claims()
returns table(identity_id uuid,driver_id uuid,client_code text,person text,vehicle_keys text[],source text,
  observed_at timestamptz,expires_at timestamptz,vehicle_label text,evidence jsonb)
language plpgsql stable security definer set search_path=public as $$
declare r record; stamp timestamptz; ttl integer;
begin
  for r in
    select l.*,d.ludy_driver_code,s.status source_status,s.last_success_at,s.stale_after_s
    from public.fleet_latest l join public.fleet_drivers d on d.id=l.driver_id
    join public.fleet_identities i on i.id=l.identity_id and i.driver_id=l.driver_id and i.source=l.source
    join public.fleet_sources s on s.id=l.source
    where coalesce(l.vehicle_label,'')<>''
  loop
    if not public.fleet_vehicle_observation_current(r.source,r.status,r.observed_at,r.evidence,
        r.source_status,r.last_success_at,r.stale_after_s) then continue; end if;
    stamp:=r.observed_at; ttl:=least(r.stale_after_s,180);
    if r.source='uber' and r.evidence->>'vehicle_observed_at' is not null then
      stamp:=(r.evidence->>'vehicle_observed_at')::timestamptz; ttl:=180;
    end if;
    identity_id:=r.identity_id; driver_id:=r.driver_id; client_code:=r.ludy_driver_code;
    person:=case when r.ludy_driver_code is not null then 'ludy:'||r.ludy_driver_code else 'profile:'||r.driver_id::text end;
    select coalesce(array_agg(v.key order by v.key),'{}'::text[]) into vehicle_keys from public.vehicles v
    where upper(coalesce(v.active,'OUI'))<>'NON' and exists(
      select 1 from unnest(array[v.key,v.plate]||regexp_split_to_array(coalesce(v.other_plates,''),'[,;]')) alias
      where public.fleet_myclicar_plate(alias)<>''
        and public.fleet_myclicar_plate(alias)=public.fleet_myclicar_plate(r.vehicle_label));
    source:=r.source; observed_at:=stamp; expires_at:=stamp+make_interval(secs=>ttl);
    vehicle_label:=r.vehicle_label; evidence:=r.evidence;
    return next;
  end loop;
end $$;
revoke all on function public.fleet_current_vehicle_claims() from public,anon,authenticated,service_role;

create function public.fleet_reconcile_vehicle_contracts()
returns jsonb language plpgsql security definer set search_path=public as $$
declare changed integer:=0; revoked integer:=0;
begin
  if (select value from public.params where key='environment') is distinct from 'staging' then
    raise exception 'Base locale de staging obligatoire';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  with claims as materialized (select * from public.fleet_current_vehicle_claims()), unique_plates as (
    -- Contradiction suspends fallback; it never chooses a winner between two
    -- competing live claims. Their later expiry must not revive an old contract.
    select x.* from claims x where cardinality(x.vehicle_keys)=1
  ), contradictions as (
    select distinct on(c.external_id) c.external_id,c.client_code,c.vehicle_key,c.effective_start_at,
      x.observed_at,jsonb_build_object('method','platform_shift','source',x.source,'driver_id',x.driver_id,
        'client_code',x.client_code,'vehicle_key',x.vehicle_keys[1],'vehicle_label',x.vehicle_label,
        'observed_at',x.observed_at,'reason',case when x.vehicle_keys[1]=c.vehicle_key then 'other_driver' else 'other_vehicle' end) evidence
    from public.fleet_myclicar_contracts c join unique_plates x on
      (x.vehicle_keys[1]=c.vehicle_key and x.client_code is distinct from c.client_code)
      or (x.client_code=c.client_code and x.vehicle_keys[1]<>c.vehicle_key)
    where c.current and c.status='IN_PROGRESS' and not c.deleted and c.end_at is null
      and c.client_code is not null and c.vehicle_key is not null and c.effective_start_at<=now()
    order by c.external_id,x.observed_at desc,x.identity_id
  ) insert into public.fleet_contract_assignment_overrides as existing
      (contract_id,client_code,vehicle_key,effective_start_at,observed_at,evidence)
    select external_id,client_code,vehicle_key,effective_start_at,observed_at,evidence from contradictions
    on conflict(contract_id) do update set client_code=excluded.client_code,vehicle_key=excluded.vehicle_key,
      effective_start_at=excluded.effective_start_at,observed_at=excluded.observed_at,evidence=excluded.evidence
    where (existing.client_code,existing.vehicle_key,existing.effective_start_at)
      is distinct from (excluded.client_code,excluded.vehicle_key,excluded.effective_start_at);
  get diagnostics changed=row_count;

  -- Revoke only the displaced automatic lease. Manual assignments remain manual.
  with displaced as (
    select d.id,d.vehicle_key,d.vehicle_link_evidence from public.fleet_drivers d
    join public.fleet_myclicar_contracts c on c.external_id=d.vehicle_link_evidence->>'contract_id'
    join public.fleet_contract_assignment_overrides o on o.contract_id=c.external_id
      and (o.client_code,o.vehicle_key,o.effective_start_at)=(c.client_code,c.vehicle_key,c.effective_start_at)
    where d.vehicle_link_method='myclicar_contract' and not d.auto_link_disabled
      and d.vehicle_key=c.vehicle_key and d.ludy_driver_code=c.client_code
  ) insert into public.fleet_link_audit(driver_id,action,method,evidence)
    select id,'vehicle_revoke','platform_shift',jsonb_build_object('vehicle_key',vehicle_key,'previous_evidence',vehicle_link_evidence) from displaced;
  delete from public.fleet_motion_checkpoints checkpoint using public.fleet_identities i,public.fleet_drivers d,
    public.fleet_myclicar_contracts c,public.fleet_contract_assignment_overrides o
  where checkpoint.identity_id=i.id and i.driver_id=d.id
    and c.external_id=d.vehicle_link_evidence->>'contract_id' and o.contract_id=c.external_id
    and (o.client_code,o.vehicle_key,o.effective_start_at)=(c.client_code,c.vehicle_key,c.effective_start_at)
    and d.vehicle_link_method='myclicar_contract' and not d.auto_link_disabled
    and d.vehicle_key=c.vehicle_key and d.ludy_driver_code=c.client_code;
  update public.fleet_drivers d set vehicle_key=null,vehicle_link_evidence='{}'
  from public.fleet_myclicar_contracts c,public.fleet_contract_assignment_overrides o
  where c.external_id=d.vehicle_link_evidence->>'contract_id' and o.contract_id=c.external_id
    and (o.client_code,o.vehicle_key,o.effective_start_at)=(c.client_code,c.vehicle_key,c.effective_start_at)
    and d.vehicle_link_method='myclicar_contract' and not d.auto_link_disabled
    and d.vehicle_key=c.vehicle_key and d.ludy_driver_code=c.client_code;
  get diagnostics revoked=row_count;
  return jsonb_build_object('overrides',changed,'revoked',revoked);
end $$;

-- Retain the proven contract validation/agency/manual/TTL guards as a private base.
alter function public.fleet_auto_link_myclicar_vehicle(uuid,text) rename to fleet_auto_link_myclicar_vehicle_contract_base;
create function public.fleet_auto_link_myclicar_vehicle(p_driver uuid,p_contract_id text)
returns boolean language plpgsql security definer set search_path=public as $$
declare c public.fleet_myclicar_contracts%rowtype; d public.fleet_drivers%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into c from public.fleet_myclicar_contracts where external_id=p_contract_id;
  if not found then return false; end if;
  select * into d from public.fleet_drivers where id=p_driver;
  if not found then return false; end if;
  if exists(select 1 from public.fleet_contract_assignment_overrides o where o.contract_id=c.external_id
      and (o.client_code,o.vehicle_key,o.effective_start_at)=(c.client_code,c.vehicle_key,c.effective_start_at)) then return false; end if;
  -- This also protects the gap before the next reconciliation, including a
  -- newly discovered profile whose Ludy identity is not known yet.
  if exists(select 1 from public.fleet_current_vehicle_claims() x
      where c.vehicle_key=any(x.vehicle_keys) and x.driver_id<>p_driver
        and x.client_code is distinct from d.ludy_driver_code) then return false; end if;
  return public.fleet_auto_link_myclicar_vehicle_contract_base(p_driver,p_contract_id);
end $$;

-- The current live vehicle wins over a stale commercial allocation. Every
-- supplied proof must still match a stored, current, unique platform observation.
create or replace function public.fleet_auto_link_vehicle(p_driver uuid,p_vehicle_key text,p_evidence jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare d public.fleet_drivers%rowtype; stamp timestamptz; expiry timestamptz; claimant text; valid boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into d from public.fleet_drivers where id=p_driver for update;
  if not found or d.auto_link_disabled or d.ludy_driver_code is null or d.vehicle_link_method='manual'
    or (d.vehicle_key is not null and d.vehicle_link_method is null) then return false; end if;
  begin stamp:=(p_evidence->>'observed_at')::timestamptz; expiry:=(p_evidence->>'expires_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then return false; end;
  if p_evidence->>'method' is distinct from 'platform_plate' or stamp is null or expiry is null
    or not isfinite(stamp) or not isfinite(expiry) or expiry<=now() or expiry<=stamp
    or expiry>now()+interval '4 minutes'
    or p_evidence->>'source'='bolt' and p_evidence->>'vehicle_origin' is distinct from 'bolt_live' then return false; end if;
  if not exists(select 1 from public.vehicles v join public.drivers r on r.code=d.ludy_driver_code
      where v.key=p_vehicle_key and upper(coalesce(v.active,'OUI'))<>'NON'
      and (r.agency_id is null or r.agency_id=v.agency_id)
      and (d.agency_id is null or d.agency_id=v.agency_id)) then return false; end if;
  claimant:='ludy:'||d.ludy_driver_code;
  with claims as materialized(select * from public.fleet_current_vehicle_claims())
    select exists(select 1 from claims x where x.driver_id=p_driver and x.source=p_evidence->>'source'
        and cardinality(x.vehicle_keys)=1 and x.vehicle_keys[1]=p_vehicle_key and x.observed_at=stamp and expiry<=x.expires_at)
      and not exists(select 1 from claims x where x.person=claimant
        and (cardinality(x.vehicle_keys)<>1 or x.vehicle_keys[1]<>p_vehicle_key))
      and not exists(select 1 from claims x where x.person<>claimant and p_vehicle_key=any(x.vehicle_keys)) into valid;
  if not valid then return false; end if;
  perform public.fleet_reconcile_vehicle_contracts();
  -- A stored automatic lease is not a second live claim. Release it immediately
  -- after a coherent shift, without waiting for its old timeout to elapse.
  insert into public.fleet_link_audit(driver_id,action,method,evidence)
    select id,'vehicle_revoke','platform_shift',jsonb_build_object('vehicle_key',vehicle_key,'next_driver_id',p_driver)
    from public.fleet_drivers where id<>p_driver and vehicle_key=p_vehicle_key
      and vehicle_link_method in('platform_plate','myclicar_contract') and not auto_link_disabled;
  delete from public.fleet_motion_checkpoints checkpoint using public.fleet_identities i,public.fleet_drivers old
    where checkpoint.identity_id=i.id and i.driver_id=old.id and old.id<>p_driver
      and old.vehicle_key=p_vehicle_key and old.vehicle_link_method in('platform_plate','myclicar_contract') and not old.auto_link_disabled;
  update public.fleet_drivers set vehicle_key=null,vehicle_link_evidence='{}'
    where id<>p_driver and vehicle_key=p_vehicle_key
      and vehicle_link_method in('platform_plate','myclicar_contract') and not auto_link_disabled;
  return public.fleet_auto_link_vehicle_platform_base(p_driver,p_vehicle_key,p_evidence);
end $$;

-- An operator confirms the person once, while subsequent vehicle shifts follow
-- live evidence. No car is inferred by this RPC; the matcher must re-evaluate it.
create function public.fleet_link_driver_automatic(p_driver uuid,p_ludy_code text,p_agency_id bigint default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare target uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  if p_ludy_code is null or not exists(select 1 from public.drivers where code=p_ludy_code) then
    raise exception 'Fiche Ludy obligatoire pour le suivi automatique';
  end if;
  target:=public.fleet_link_driver(p_driver,p_ludy_code,null,p_agency_id);
  update public.fleet_drivers set auto_link_disabled=false,vehicle_link_method=null,vehicle_key=null,
    vehicle_link_evidence='{}' where id=target;
  delete from public.fleet_motion_checkpoints checkpoint using public.fleet_identities i
    where checkpoint.identity_id=i.id and i.driver_id=target;
  insert into public.fleet_link_audit(driver_id,action,method,evidence)
    values(target,'vehicle_mode','automatic',jsonb_build_object('ludy_driver_code',p_ludy_code,'vehicle_mode','automatic'));
  return target;
end $$;

revoke all on function public.fleet_reconcile_vehicle_contracts(),public.fleet_link_driver_automatic(uuid,text,bigint),
  public.fleet_auto_link_vehicle(uuid,text,jsonb),public.fleet_auto_link_myclicar_vehicle(uuid,text),
  public.fleet_auto_link_myclicar_vehicle_contract_base(uuid,text) from public,anon,authenticated;
revoke all on function public.fleet_auto_link_myclicar_vehicle_contract_base(uuid,text),
  public.fleet_auto_link_vehicle_platform_base(uuid,text,jsonb) from service_role;
grant execute on function public.fleet_reconcile_vehicle_contracts(),public.fleet_link_driver_automatic(uuid,text,bigint),
  public.fleet_auto_link_vehicle(uuid,text,jsonb),public.fleet_auto_link_myclicar_vehicle(uuid,text) to service_role;
