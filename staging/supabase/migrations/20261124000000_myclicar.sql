-- Staging only. Complete read-only MyClicar snapshots; no provider writes or jobs.
create table public.fleet_myclicar_contracts (
  external_id text primary key, num text not null unique, client_code text,
  name text, plate text, temporary_plate text, model text, status text not null,
  start_at timestamptz, effective_start_at timestamptz, end_at timestamptz,
  provider_updated_at timestamptz, deleted boolean not null default false,
  vehicle_key text references public.vehicles(key) on delete set null,
  vehicle_candidates text[] not null default '{}',
  current boolean not null default false, eligible boolean not null default false,
  reason text not null default '', observed_at timestamptz not null,
  check(length(external_id) between 1 and 120 and length(num) between 1 and 120)
);
create index fleet_myclicar_current_driver on public.fleet_myclicar_contracts(client_code) where current;
create index fleet_myclicar_current_vehicle on public.fleet_myclicar_contracts(vehicle_key) where current;
alter table public.fleet_myclicar_contracts enable row level security;
revoke all on public.fleet_myclicar_contracts from public,anon,authenticated;
grant select on public.fleet_myclicar_contracts to authenticated;
grant all on public.fleet_myclicar_contracts to service_role;
create policy read_admin on public.fleet_myclicar_contracts for select to authenticated using(public.is_admin());

create function public.fleet_myclicar_plate(p_value text) returns text
language sql immutable set search_path=public as $$
  select regexp_replace(upper(coalesce(p_value,'')),'[^0-9]','','g') ||
    regexp_replace(upper(coalesce(p_value,'')),'[^A-Z]','','g')
$$;

create function public.fleet_sync_myclicar(p_contracts jsonb,p_observed_at timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  if (select value from public.params where key='environment') is distinct from 'staging' then
    raise exception 'Base locale de staging obligatoire';
  end if;
  if jsonb_typeof(p_contracts) is distinct from 'array' or jsonb_array_length(p_contracts)>10000
    or p_observed_at is null or p_observed_at>now()+interval '5 seconds' or p_observed_at<now()-interval '300 seconds' then
    raise exception 'Snapshot MyClicar complet et récent obligatoire';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  if p_observed_at<(select max(observed_at) from public.fleet_myclicar_contracts) then
    raise exception 'Snapshot MyClicar antérieur au dernier import';
  end if;
  create temporary table _myclicar_input on commit drop as
    select external_id,num,client_code,name,plate,temporary_plate,model,status,start_at,effective_start_at,end_at,
      provider_updated_at,coalesce(deleted,false) deleted,null::text vehicle_key,'{}'::text[] vehicle_candidates,
      false eligible,''::text reason
    from jsonb_populate_recordset(null::public.fleet_myclicar_contracts,p_contracts);
  if exists(select 1 from _myclicar_input where coalesce(external_id,'')='' or length(external_id)>120
      or coalesce(num,'')='' or length(num)>120 or coalesce(status,'')='' or length(client_code)>120
      or end_at<start_at)
    or exists(select 1 from _myclicar_input group by external_id having count(*)>1)
    or exists(select 1 from _myclicar_input group by num having count(*)>1)
    or exists(select 1 from _myclicar_input i join public.fleet_myclicar_contracts c on c.num=i.num where c.external_id<>i.external_id) then
    raise exception 'Contrats MyClicar invalides ou identifiants contradictoires';
  end if;
  -- Resolve only existing vehicles. A shared current/historical plate remains ambiguous.
  update _myclicar_input i set vehicle_candidates=coalesce((
    select array_agg(distinct v.key order by v.key) from public.vehicles v
    where exists(select 1 from unnest(array[v.key,v.plate]||regexp_split_to_array(coalesce(v.other_plates,''),'[,;]')) alias
      where public.fleet_myclicar_plate(alias)<>'' and public.fleet_myclicar_plate(alias) in
        (public.fleet_myclicar_plate(i.plate),public.fleet_myclicar_plate(i.temporary_plate)))
  ),'{}') where i.external_id is not null;
  update _myclicar_input set vehicle_key=vehicle_candidates[1] where cardinality(vehicle_candidates)=1;
  update _myclicar_input i set reason=case
    when i.status<>'IN_PROGRESS' or i.deleted or i.end_at is not null then 'not_active'
    when i.effective_start_at is null then 'departure_unconfirmed'
    when i.effective_start_at>p_observed_at then 'future_departure'
    when not exists(select 1 from public.drivers d where d.code=i.client_code) then 'unknown_driver'
    when cardinality(i.vehicle_candidates)=0 then 'unknown_vehicle'
    when cardinality(i.vehicle_candidates)>1 then 'ambiguous_vehicle'
    when not exists(select 1 from public.vehicles v where v.key=i.vehicle_key and upper(coalesce(v.active,'OUI'))<>'NON') then 'inactive_vehicle'
    when exists(select 1 from public.drivers d join public.vehicles v on v.key=i.vehicle_key
      where d.code=i.client_code and d.agency_id is not null and v.agency_id is distinct from d.agency_id) then 'agency_mismatch'
    when exists(select 1 from _myclicar_input other where other.external_id<>i.external_id
      and other.status='IN_PROGRESS' and not other.deleted and other.end_at is null and other.effective_start_at<=p_observed_at
      and (other.client_code=i.client_code or i.vehicle_key=any(other.vehicle_candidates))) then 'conflicting_contracts'
    else 'matched' end where i.external_id is not null;
  update _myclicar_input set eligible=reason='matched' where external_id is not null;

  -- Missing rows revoke current evidence only; absence never fabricates an actual return.
  update public.fleet_myclicar_contracts set current=false,eligible=false,reason='absent_from_complete_snapshot',observed_at=p_observed_at where current;
  insert into public.fleet_myclicar_contracts(external_id,num,client_code,name,plate,temporary_plate,model,status,start_at,effective_start_at,end_at,
    provider_updated_at,deleted,vehicle_key,vehicle_candidates,current,eligible,reason,observed_at)
  select external_id,num,client_code,name,plate,temporary_plate,model,status,start_at,effective_start_at,end_at,
    provider_updated_at,deleted,vehicle_key,vehicle_candidates,true,eligible,reason,p_observed_at from _myclicar_input
  on conflict(external_id) do update set num=excluded.num,client_code=excluded.client_code,name=excluded.name,plate=excluded.plate,
    temporary_plate=excluded.temporary_plate,model=excluded.model,status=excluded.status,start_at=excluded.start_at,effective_start_at=excluded.effective_start_at,
    end_at=excluded.end_at,provider_updated_at=excluded.provider_updated_at,deleted=excluded.deleted,vehicle_key=excluded.vehicle_key,
    vehicle_candidates=excluded.vehicle_candidates,current=true,eligible=excluded.eligible,reason=excluded.reason,observed_at=excluded.observed_at;

  -- Keep contacts, manual driver records, local agency choices and Geotab links intact.
  -- Never invoke refresh_drivers(), which deletes reference rows and matches Uber accounts.
  insert into public.contracts(num,client_code,name,plate,vehicle_key,model,start_at,end_at,status,origin,imported_at,updated_at)
  select i.num,i.client_code,i.name,coalesce(nullif(i.plate,''),i.temporary_plate),i.vehicle_key,i.model,i.start_at,i.end_at,i.status,'MyClicar',now(),now()
  from _myclicar_input i join public.drivers d on d.code=i.client_code
  where i.vehicle_key is not null and i.start_at is not null and not i.deleted
  on conflict(num) do update set client_code=excluded.client_code,name=excluded.name,plate=excluded.plate,vehicle_key=excluded.vehicle_key,
    model=excluded.model,start_at=excluded.start_at,end_at=excluded.end_at,status=excluded.status,origin=excluded.origin,
    imported_at=coalesce(contracts.imported_at,excluded.imported_at),updated_at=excluded.updated_at
  where (contracts.client_code,contracts.name,contracts.plate,contracts.vehicle_key,contracts.model,contracts.start_at,contracts.end_at,contracts.status,contracts.origin)
    is distinct from (excluded.client_code,excluded.name,excluded.plate,excluded.vehicle_key,excluded.model,excluded.start_at,excluded.end_at,excluded.status,excluded.origin);
  with stats as (
    select d.code,count(c.num)::integer n,min(c.start_at) first_at,max(c.start_at) last_at
    from public.drivers d left join public.contracts c on c.client_code=d.code and c.start_at is not null
    where d.code in(select client_code from _myclicar_input) group by d.code
  ) update public.drivers d set n_contracts=s.n,first_contract=s.first_at,last_contract=s.last_at from stats s where s.code=d.code;

  insert into public.fleet_link_audit(driver_id,action,method,evidence)
  select d.id,'vehicle_revoke','myclicar_contract',jsonb_build_object('vehicle_key',d.vehicle_key,'at',p_observed_at,'reason','contract_no_longer_current')
  from public.fleet_drivers d where d.vehicle_link_method='myclicar_contract' and not d.auto_link_disabled and d.vehicle_key is not null
    and not exists(select 1 from public.fleet_myclicar_contracts c where c.current and c.eligible
      and c.external_id=d.vehicle_link_evidence->>'contract_id' and c.client_code=d.ludy_driver_code and c.vehicle_key=d.vehicle_key);
  delete from public.fleet_motion_checkpoints checkpoint using public.fleet_identities identity,public.fleet_drivers d
  where checkpoint.identity_id=identity.id and identity.driver_id=d.id
    and d.vehicle_link_method='myclicar_contract' and not d.auto_link_disabled and d.vehicle_key is not null
    and not exists(select 1 from public.fleet_myclicar_contracts c where c.current and c.eligible
      and c.external_id=d.vehicle_link_evidence->>'contract_id' and c.client_code=d.ludy_driver_code and c.vehicle_key=d.vehicle_key);
  update public.fleet_drivers d set vehicle_key=null,vehicle_link_evidence='{}'
  where d.vehicle_link_method='myclicar_contract' and not d.auto_link_disabled and d.vehicle_key is not null
    and not exists(select 1 from public.fleet_myclicar_contracts c where c.current and c.eligible
      and c.external_id=d.vehicle_link_evidence->>'contract_id' and c.client_code=d.ludy_driver_code and c.vehicle_key=d.vehicle_key);

  select jsonb_build_object('contracts',count(*),'active_contracts',count(*) filter(where status='IN_PROGRESS' and not deleted and end_at is null and effective_start_at<=p_observed_at),
    'matched_assignments',count(*) filter(where eligible),'unmatched_contracts',count(*) filter(where not eligible),
    'unmatched_drivers',count(*) filter(where reason='unknown_driver'),'unmatched_vehicles',count(*) filter(where reason in('unknown_vehicle','ambiguous_vehicle')),
    'ambiguous',count(*) filter(where reason in('ambiguous_vehicle','conflicting_contracts'))) into result from _myclicar_input;
  drop table _myclicar_input;
  return result;
end $$;

create function public.fleet_auto_link_myclicar_vehicle(p_driver uuid,p_contract_id text)
returns boolean language plpgsql security definer set search_path=public as $$
declare d public.fleet_drivers%rowtype; c public.fleet_myclicar_contracts%rowtype; s public.fleet_sources%rowtype; expiry timestamptz; proof jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into d from public.fleet_drivers where id=p_driver for update;
  if not found or d.auto_link_disabled or d.ludy_driver_code is null or d.vehicle_link_method='manual'
    or d.vehicle_key is not null and d.vehicle_link_method is null then return false; end if;
  select * into c from public.fleet_myclicar_contracts where external_id=p_contract_id;
  if not found or not c.current or not c.eligible or c.client_code is distinct from d.ludy_driver_code
    or c.status<>'IN_PROGRESS' or c.deleted or c.end_at is not null or c.effective_start_at is null or c.effective_start_at>now()
    or c.observed_at>now()+interval '5 seconds' then return false; end if;
  select * into s from public.fleet_sources where id='myclicar';
  if s.status is distinct from 'healthy' or s.last_success_at is null or s.last_success_at>now()+interval '5 seconds' then return false; end if;
  expiry:=least(c.observed_at,s.last_success_at)+make_interval(secs=>least(s.stale_after_s,300));
  if expiry<=now() then return false; end if;
  if not exists(select 1 from public.vehicles v join public.drivers r on r.code=d.ludy_driver_code
      where v.key=c.vehicle_key and upper(coalesce(v.active,'OUI'))<>'NON'
      and (r.agency_id is null or r.agency_id=v.agency_id) and (d.agency_id is null or d.agency_id=v.agency_id)) then return false; end if;
  if exists(select 1 from public.fleet_myclicar_contracts other where other.current and other.external_id<>c.external_id
      and other.status='IN_PROGRESS' and not other.deleted and other.end_at is null and other.effective_start_at<=now()
      and (other.client_code=c.client_code or c.vehicle_key=any(other.vehicle_candidates))) then return false; end if;
  -- A fresh visible/live platform contradiction also blocks a contract-based assignment.
  if exists(select 1 from public.fleet_latest l join public.fleet_sources src on src.id=l.source
    where l.driver_id=d.id and coalesce(l.vehicle_label,'')<>'' and src.status='healthy'
      and l.observed_at<=now()+interval '5 seconds' and l.observed_at>=now()-make_interval(secs=>src.stale_after_s)
      and src.last_success_at<=now()+interval '5 seconds' and src.last_success_at>=now()-make_interval(secs=>src.stale_after_s)
      and coalesce(l.evidence->>'account_status','') not in('suspended','deactivated')
      and ((l.source='uber' and coalesce(l.evidence->>'method','visible_dom')='visible_dom')
        or (l.source='bolt' and l.evidence->>'method'='official_api' and l.evidence->>'vehicle_origin'='bolt_live' and l.status in('available','on_trip','to_pickup','on_break')))
      and not exists(select 1 from public.vehicles v,unnest(array[v.key,v.plate]||regexp_split_to_array(coalesce(v.other_plates,''),'[,;]')) alias
        where v.key=c.vehicle_key and public.fleet_myclicar_plate(alias)=public.fleet_myclicar_plate(l.vehicle_label))) then return false; end if;
  update public.fleet_drivers set vehicle_key=null,vehicle_link_evidence='{}'
    where id<>p_driver and vehicle_key=c.vehicle_key and vehicle_link_method in('platform_plate','myclicar_contract') and not auto_link_disabled
      and coalesce((vehicle_link_evidence->>'expires_at')::timestamptz,'-infinity'::timestamptz)<=now();
  if exists(select 1 from public.fleet_drivers where id<>p_driver and vehicle_key=c.vehicle_key) then return false; end if;
  proof:=jsonb_build_object('method','myclicar_contract','source','myclicar','contract_id',c.external_id,'contract_num',c.num,
    'client_code',c.client_code,'vehicle_key',c.vehicle_key,'observed_at',c.observed_at,'expires_at',expiry);
  if d.vehicle_key is distinct from c.vehicle_key or d.vehicle_link_method is distinct from 'myclicar_contract'
    or d.vehicle_link_evidence->>'contract_id' is distinct from c.external_id then
    insert into public.fleet_link_audit(driver_id,action,method,evidence)
      values(p_driver,'vehicle','myclicar_contract',proof||jsonb_build_object('previous_vehicle_key',d.vehicle_key));
  end if;
  update public.fleet_drivers set vehicle_key=c.vehicle_key,vehicle_link_method='myclicar_contract',vehicle_link_evidence=proof where id=p_driver;
  return true;
end $$;

-- Recheck contract conflicts under the same lock even if a platform matching plan
-- was computed just before a newer MyClicar snapshot arrived.
alter function public.fleet_auto_link_vehicle(uuid,text,jsonb) rename to fleet_auto_link_vehicle_platform_base;
create function public.fleet_auto_link_vehicle(p_driver uuid,p_vehicle_key text,p_evidence jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  if exists(select 1 from public.fleet_myclicar_contracts c join public.fleet_drivers d on d.ludy_driver_code=c.client_code
    join public.fleet_sources s on s.id='myclicar'
    where d.id=p_driver and c.current and c.status='IN_PROGRESS' and not c.deleted and c.end_at is null and c.effective_start_at<=now()
      and c.observed_at<=now()+interval '5 seconds' and c.observed_at>=now()-make_interval(secs=>least(s.stale_after_s,300))
      and s.status='healthy' and s.last_success_at<=now()+interval '5 seconds' and s.last_success_at>=now()-make_interval(secs=>least(s.stale_after_s,300))
      and (not c.eligible or c.vehicle_key is distinct from p_vehicle_key)) then return false; end if;
  return public.fleet_auto_link_vehicle_platform_base(p_driver,p_vehicle_key,p_evidence);
end $$;

revoke all on function public.fleet_myclicar_plate(text),public.fleet_sync_myclicar(jsonb,timestamptz),public.fleet_auto_link_myclicar_vehicle(uuid,text),
  public.fleet_auto_link_vehicle(uuid,text,jsonb),public.fleet_auto_link_vehicle_platform_base(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.fleet_myclicar_plate(text),public.fleet_sync_myclicar(jsonb,timestamptz),public.fleet_auto_link_myclicar_vehicle(uuid,text),public.fleet_auto_link_vehicle(uuid,text,jsonb) to service_role;
revoke all on function public.fleet_auto_link_vehicle_platform_base(uuid,text,jsonb) from service_role;
