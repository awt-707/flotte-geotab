-- A fresh return to the contract's vehicle is a new, explicit assignment proof.
-- An expired/offline former claimant alone must never restore the old holder.
do $$ begin if(select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;end $$;
-- Old barriers only stored the first contradiction. Their complete sequence is
-- unknown, so they require a newly observed return after this migration.
alter table public.fleet_contract_assignment_overrides add column latest_conflict_at timestamptz not null default now()
  check(isfinite(latest_conflict_at));
alter function public.fleet_reconcile_vehicle_contracts() rename to fleet_reconcile_vehicle_contracts_identity_base;
revoke all on function public.fleet_reconcile_vehicle_contracts_identity_base() from public,anon,authenticated,service_role;

create function public.fleet_reconcile_vehicle_contracts()
returns jsonb language plpgsql security definer set search_path=public as $$
declare receipt jsonb; lifted integer;
begin
  -- Preserves the existing staging/advisory-lock, contradiction and identity guards.
  receipt:=public.fleet_reconcile_vehicle_contracts_identity_base();
  with claims as materialized(select * from public.fleet_current_vehicle_claims()), latest_conflicts as (
    select o.contract_id,max(x.observed_at) observed_at
    from public.fleet_contract_assignment_overrides o
    join public.fleet_myclicar_contracts c on c.external_id=o.contract_id
      and (o.client_code,o.vehicle_key,o.effective_start_at)=(c.client_code,c.vehicle_key,c.effective_start_at)
    join claims x on cardinality(x.vehicle_keys)=1 and
      ((x.vehicle_keys[1]=c.vehicle_key and x.client_code is distinct from c.client_code)
        or (x.client_code=c.client_code and x.vehicle_keys[1]<>c.vehicle_key))
    where c.current and c.status='IN_PROGRESS' and not c.deleted and c.end_at is null
    group by o.contract_id
  )
  update public.fleet_contract_assignment_overrides o set latest_conflict_at=x.observed_at
    from latest_conflicts x where o.contract_id=x.contract_id and x.observed_at>o.latest_conflict_at;
  with claims as materialized(select * from public.fleet_current_vehicle_claims()), confirmed as (
    select distinct on(o.contract_id) o.contract_id,x.driver_id,x.source,x.observed_at,x.vehicle_label
    from public.fleet_contract_assignment_overrides o
    join public.fleet_myclicar_contracts c on c.external_id=o.contract_id
      and (o.client_code,o.vehicle_key,o.effective_start_at)=(c.client_code,c.vehicle_key,c.effective_start_at)
    join public.fleet_sources s on s.id='myclicar'
    join claims x on x.client_code=c.client_code and cardinality(x.vehicle_keys)=1 and x.vehicle_keys[1]=c.vehicle_key
    join public.fleet_drivers d on d.id=x.driver_id and d.ludy_driver_code=c.client_code
    join public.drivers r on r.code=c.client_code
    join public.vehicles v on v.key=c.vehicle_key
    where c.current and c.eligible and c.status='IN_PROGRESS' and not c.deleted and c.end_at is null
      and c.effective_start_at<=now() and c.observed_at between now()-interval '300 seconds' and now()+interval '5 seconds'
      and s.status='healthy' and s.stale_after_s>0
      and s.last_success_at between now()-make_interval(secs=>least(s.stale_after_s,300)) and now()+interval '5 seconds'
      and c.observed_at>=now()-make_interval(secs=>least(s.stale_after_s,300))
      and d.link_method in('manual','exact_name','name_spacing') and not d.auto_link_disabled
      and d.vehicle_link_method is distinct from 'manual'
      and not(d.vehicle_key is not null and d.vehicle_link_method is null)
      and upper(coalesce(v.active,'OUI'))<>'NON'
      and (r.agency_id is null or r.agency_id=v.agency_id)
      and (d.agency_id is null or d.agency_id=v.agency_id)
      and o.evidence->>'method'='platform_shift'
      and o.evidence->>'reason' in('other_driver','other_vehicle')
      and o.evidence->>'source' in('uber','bolt')
      and x.observed_at>greatest(o.observed_at,o.latest_conflict_at) and x.observed_at>=c.effective_start_at
      and not exists(select 1 from claims other where other.person<>x.person and c.vehicle_key=any(other.vehicle_keys))
      and not exists(select 1 from claims other where other.person=x.person
        and (cardinality(other.vehicle_keys)<>1 or other.vehicle_keys[1]<>c.vehicle_key))
      and not exists(select 1 from public.fleet_myclicar_contracts other where other.external_id<>c.external_id
        and other.current and other.status='IN_PROGRESS' and not other.deleted and other.end_at is null
        and other.effective_start_at<=now() and other.observed_at between now()-interval '300 seconds' and now()+interval '5 seconds'
        and (other.client_code=c.client_code or other.vehicle_key=c.vehicle_key or c.vehicle_key=any(other.vehicle_candidates)))
      and not exists(select 1 from public.fleet_drivers other where other.id<>d.id and other.vehicle_key=c.vehicle_key
        and (other.auto_link_disabled or other.vehicle_link_method='manual' or other.vehicle_link_method is null))
    order by o.contract_id,x.observed_at desc,x.driver_id
  ), removed as (
    delete from public.fleet_contract_assignment_overrides o using confirmed c
    where o.contract_id=c.contract_id
    returning c.driver_id,c.source,c.observed_at as confirmed_observed_at,c.vehicle_label,
      o.contract_id,o.client_code,o.vehicle_key,o.effective_start_at,o.observed_at,o.latest_conflict_at,o.evidence
  )
  insert into public.fleet_link_audit(driver_id,action,method,evidence)
  select driver_id,'contract_return_confirmed','platform_return',
    jsonb_build_object('contract_id',contract_id,'client_code',client_code,'vehicle_key',vehicle_key,
      'effective_start_at',effective_start_at,'previous_observed_at',observed_at,'previous_evidence',evidence,
      'latest_conflict_at',latest_conflict_at,
      'source',source,'vehicle_label',vehicle_label,'observed_at',confirmed_observed_at,'confirmed_at',now())
  from removed;
  get diagnostics lifted=row_count;
  return receipt||jsonb_build_object('contract_returns_confirmed',lifted);
end $$;
revoke all on function public.fleet_reconcile_vehicle_contracts() from public,anon,authenticated;
grant execute on function public.fleet_reconcile_vehicle_contracts() to service_role;
