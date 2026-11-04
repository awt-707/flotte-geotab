-- Staging only: actual MyClicar handover times, never scheduled returns.
create table public.fleet_rotation_contracts (
 external_id text primary key check(length(external_id) between 1 and 120),
 num text not null check(length(num) between 1 and 120), client_code text,
 plate text, temporary_plate text, model text, status text not null check(status in('DONE','VEHICLE_RETURNED')),
 effective_start_at timestamptz, end_at timestamptz, provider_updated_at timestamptz,
 deleted boolean not null default false,
 vehicle_key text references public.vehicles(key) on delete set null,
 agency_id bigint references public.agencies(id) on delete set null,
 observed_at timestamptz not null,
 check(effective_start_at is null or isfinite(effective_start_at)),
 check(end_at is null or isfinite(end_at) and (effective_start_at is null or end_at>=effective_start_at))
);
create index fleet_rotation_vehicle_time on public.fleet_rotation_contracts(vehicle_key,effective_start_at);
create index fleet_rotation_agency_return on public.fleet_rotation_contracts(agency_id,end_at);
alter table public.fleet_rotation_contracts enable row level security;
revoke all on public.fleet_rotation_contracts from public,anon,authenticated;
grant select on public.fleet_rotation_contracts to authenticated;
grant all on public.fleet_rotation_contracts to service_role;
create policy read_scope on public.fleet_rotation_contracts for select to authenticated using(
 public.my_role() in('admin','manager','viewer') and (public.is_admin() or agency_id=any(public.my_agency_ids()))
);
create table public.fleet_rotation_sync (
 id integer primary key default 1 check(id=1), status text not null default 'unconnected' check(status in('unconnected','healthy','error')),
 last_attempt_at timestamptz,last_success_at timestamptz,last_error text,from_at timestamptz,to_at timestamptz
);
insert into public.fleet_rotation_sync(id) values(1);
alter table public.fleet_rotation_sync enable row level security;
revoke all on public.fleet_rotation_sync from public,anon,authenticated;
grant select on public.fleet_rotation_sync to authenticated;
grant all on public.fleet_rotation_sync to service_role;
create policy read_staff on public.fleet_rotation_sync for select to authenticated using(public.my_role() in('admin','manager','viewer'));

create function public.fleet_sync_rotation_contracts(p_contracts jsonb,p_observed_at timestamptz,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare saved integer;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Base locale de staging obligatoire';end if;
 if p_contracts is null or jsonb_typeof(p_contracts)<>'array' or jsonb_array_length(p_contracts)>2000 or pg_column_size(p_contracts)>8388608
   or p_observed_at is null or not isfinite(p_observed_at) or p_observed_at>now()+interval '5 seconds' or p_observed_at<now()-interval '5 minutes'
   or p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_from>=p_to or p_to-p_from>interval '31 days'
   or p_from<now()-interval '90 days' or p_to>now()+interval '1 day' then raise exception 'Historique de rotation invalide';end if;
 perform pg_advisory_xact_lock(hashtextextended('fleet-rotation-contracts',0));
 if p_observed_at<(select last_success_at from public.fleet_rotation_sync where id=1) then raise exception 'Historique antérieur au dernier import';end if;
 create temporary table _rotation_input on commit drop as
 select external_id,num,client_code,plate,temporary_plate,model,status,effective_start_at,end_at,provider_updated_at,coalesce(deleted,false) deleted,
   null::text vehicle_key,null::bigint agency_id
 from jsonb_populate_recordset(null::public.fleet_rotation_contracts,p_contracts);
 if exists(select 1 from _rotation_input where coalesce(external_id,'')='' or length(external_id)>120 or coalesce(num,'')='' or length(num)>120
   or status is null or status not in('DONE','VEHICLE_RETURNED') or deleted or length(client_code)>120
   or effective_start_at is not null and (not isfinite(effective_start_at) or effective_start_at>p_observed_at+interval '5 seconds')
   or end_at is not null and (not isfinite(end_at) or end_at>p_observed_at+interval '5 seconds' or end_at<effective_start_at)
   or provider_updated_at is not null and not isfinite(provider_updated_at))
   or exists(select 1 from _rotation_input group by external_id having count(*)>1)
   or exists(select 1 from _rotation_input group by num having count(*)>1) then raise exception 'Contrats de rotation invalides';end if;
 update _rotation_input i set vehicle_key=match.key,agency_id=match.agency_id from (
  select i.external_id,min(v.key) key,min(v.agency_id) agency_id from _rotation_input i join public.vehicles v on exists(
   select 1 from unnest(array[v.key,v.plate]||regexp_split_to_array(coalesce(v.other_plates,''),'[,;]')) alias
   where public.fleet_myclicar_plate(alias)<>'' and public.fleet_myclicar_plate(alias) in(public.fleet_myclicar_plate(i.plate),public.fleet_myclicar_plate(i.temporary_plate)))
  group by i.external_id having count(distinct v.key)=1
 ) match where i.external_id=match.external_id;
 insert into public.fleet_rotation_contracts(external_id,num,client_code,plate,temporary_plate,model,status,effective_start_at,end_at,provider_updated_at,deleted,vehicle_key,agency_id,observed_at)
 select external_id,num,client_code,plate,temporary_plate,model,status,effective_start_at,end_at,provider_updated_at,deleted,vehicle_key,agency_id,p_observed_at from _rotation_input
 on conflict(external_id) do update set num=excluded.num,client_code=excluded.client_code,plate=excluded.plate,temporary_plate=excluded.temporary_plate,
  model=excluded.model,status=excluded.status,effective_start_at=excluded.effective_start_at,end_at=excluded.end_at,
  provider_updated_at=excluded.provider_updated_at,deleted=excluded.deleted,vehicle_key=excluded.vehicle_key,agency_id=excluded.agency_id,observed_at=excluded.observed_at
 where excluded.observed_at>=fleet_rotation_contracts.observed_at;
 get diagnostics saved=row_count;
 update public.fleet_rotation_sync set status='healthy',last_attempt_at=p_observed_at,last_success_at=p_observed_at,last_error=null,from_at=p_from,to_at=p_to where id=1;
 drop table _rotation_input;
 return jsonb_build_object('contracts',saved);
end $$;
revoke all on function public.fleet_sync_rotation_contracts(jsonb,timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.fleet_sync_rotation_contracts(jsonb,timestamptz,timestamptz,timestamptz) to service_role;
