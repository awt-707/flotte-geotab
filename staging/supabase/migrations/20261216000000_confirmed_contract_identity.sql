-- An unidentified platform profile can temporarily contradict a contract.
-- Once that exact person is identified as its holder, a fresh unambiguous plate
-- confirms that the original contradiction was not a change of driver.
alter function public.fleet_reconcile_vehicle_contracts() rename to fleet_reconcile_vehicle_contracts_shift_base;
revoke all on function public.fleet_reconcile_vehicle_contracts_shift_base() from public,anon,authenticated,service_role;

create function public.fleet_reconcile_vehicle_contracts()
returns jsonb language plpgsql security definer set search_path=public as $$
declare receipt jsonb; lifted integer;
begin
  receipt:=public.fleet_reconcile_vehicle_contracts_shift_base();
  with claims as materialized(select * from public.fleet_current_vehicle_claims()), confirmed as (
    select distinct o.contract_id,x.driver_id
    from public.fleet_contract_assignment_overrides o
    join public.fleet_myclicar_contracts c on c.external_id=o.contract_id
      and (o.client_code,o.vehicle_key,o.effective_start_at)=(c.client_code,c.vehicle_key,c.effective_start_at)
    join public.fleet_sources s on s.id='myclicar'
    join claims x on x.client_code=c.client_code and cardinality(x.vehicle_keys)=1 and x.vehicle_keys[1]=c.vehicle_key
    join public.fleet_drivers d on d.id=x.driver_id and d.ludy_driver_code=c.client_code
    where c.current and c.eligible and c.status='IN_PROGRESS' and not c.deleted and c.end_at is null
      and c.effective_start_at<=now() and c.observed_at between now()-interval '300 seconds' and now()+interval '5 seconds'
      and s.status='healthy' and s.stale_after_s>0
      and s.last_success_at between now()-make_interval(secs=>least(s.stale_after_s,300)) and now()+interval '5 seconds'
      and c.observed_at>=now()-make_interval(secs=>least(s.stale_after_s,300))
      and d.link_method in('manual','exact_name','name_spacing')
      and o.evidence->>'method'='platform_shift' and o.evidence->>'reason'='other_driver'
      and o.evidence->>'source' in('uber','bolt') and o.evidence->>'vehicle_key'=c.vehicle_key
      and jsonb_typeof(o.evidence->'client_code')='null'
      and (o.evidence->>'driver_id'=d.id::text or exists(
        select 1 from public.fleet_link_audit a where a.driver_id=d.id and a.action='associate'
          and a.method in('exact_name','name_spacing') and a.evidence->>'previous_driver_id'=o.evidence->>'driver_id'
          and a.evidence->>'ludy_driver_code'=c.client_code))
      and not exists(select 1 from claims other where other.person<>x.person and c.vehicle_key=any(other.vehicle_keys))
      and not exists(select 1 from claims other where other.person=x.person
        and (cardinality(other.vehicle_keys)<>1 or other.vehicle_keys[1]<>c.vehicle_key))
  ), removed as (
    delete from public.fleet_contract_assignment_overrides o using confirmed c
    where o.contract_id=c.contract_id
    returning c.driver_id,o.contract_id,o.client_code,o.vehicle_key,o.effective_start_at,o.observed_at,o.evidence
  )
  insert into public.fleet_link_audit(driver_id,action,method,evidence)
  select driver_id,'contract_identity_confirmed','confirmed_identity',
    jsonb_build_object('contract_id',contract_id,'client_code',client_code,'vehicle_key',vehicle_key,
      'effective_start_at',effective_start_at,'previous_observed_at',observed_at,'previous_evidence',evidence,'confirmed_at',now())
  from removed;
  get diagnostics lifted=row_count;
  return receipt||jsonb_build_object('identity_contradictions_cleared',lifted);
end $$;
revoke all on function public.fleet_reconcile_vehicle_contracts() from public,anon,authenticated;
grant execute on function public.fleet_reconcile_vehicle_contracts() to service_role;
