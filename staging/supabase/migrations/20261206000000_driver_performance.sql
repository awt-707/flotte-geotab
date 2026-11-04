-- Additional documented Bolt/Uber ride fields. No passenger identity or street
-- address is stored; stop coordinates support a point map, not an invented track.
do $$ begin if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;end $$;
alter table public.fleet_rides
 add column requested_at timestamptz,
 add column accepted_at timestamptz,
 add column pickup_duration_s numeric check(pickup_duration_s>=0),
 add column passenger_distance_km numeric check(passenger_distance_km>=0),
 add column tip_amount numeric,
 add column booking_fee numeric,
 add column toll_fee numeric,
 add column cancellation_fee numeric,
 add column stops jsonb not null default '[]' check(jsonb_typeof(stops)='array' and jsonb_array_length(stops)<=30 and pg_column_size(stops)<=16384),
 add column provider_driver_id text,
 add column detail_origin text not null default 'legacy' check(detail_origin in('legacy','bolt_api','uber_report')),
 add column is_optional boolean;
create index fleet_rides_driver_requested on public.fleet_rides(driver_id,source,requested_at);

create table public.fleet_driver_performance_sync (
 source text not null references public.fleet_sources(id) check(source in('uber','bolt')),
 organization_id text not null,driver_id uuid not null references public.fleet_drivers(id) on delete cascade,
 covered_from timestamptz,covered_to timestamptz,last_attempt_at timestamptz,last_success_at timestamptz,
 status text not null default 'unconnected' check(status in('unconnected','healthy','error')),
 row_count integer not null default 0 check(row_count>=0),last_error text,
 primary key(source,organization_id,driver_id),
 check((covered_from is null and covered_to is null) or covered_from is not null and covered_to is not null and covered_to>covered_from)
);
alter table public.fleet_driver_performance_sync enable row level security;
revoke all on public.fleet_driver_performance_sync from public,anon,authenticated;
grant select on public.fleet_driver_performance_sync to authenticated;
grant all on public.fleet_driver_performance_sync to service_role;
create policy staff_driver_scope on public.fleet_driver_performance_sync for select to authenticated
 using(public.my_role() in('admin','manager','viewer') and public.fleet_can_read(driver_id));

-- A whole provider read commits together, including empty-driver coverage.
-- Identity is rechecked in this transaction; a stale mapping is never accepted.
create function public.fleet_import_bolt_performance(p_org text,p_rows jsonb,p_coverage jsonb,p_at timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare entry jsonb; coverage jsonb; target uuid; f timestamptz; t timestamptz; n integer:=0;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 if p_org is null or p_org !~ '^[1-9][0-9]*$' or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>20000
  or jsonb_typeof(p_coverage) is distinct from 'array' or jsonb_array_length(p_coverage)>1000 or jsonb_array_length(p_coverage)=0
  or p_at is null or not isfinite(p_at) or p_at>now()+interval '5 minutes' then raise exception 'Invalid provider batch';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) r group by r->>'external_id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(p_coverage) c group by c->>'driver_id' having count(*)>1) then raise exception 'Duplicate provider identity';end if;
 for coverage in select value from jsonb_array_elements(p_coverage) loop
  target:=(coverage->>'driver_id')::uuid;f:=(coverage->>'from_at')::timestamptz;t:=(coverage->>'to_at')::timestamptz;
  if target is null or f is null or t is null or not isfinite(f) or not isfinite(t) or t<=f or t-f>interval '31 days' or t>p_at+interval '5 minutes'
   or not exists(select 1 from public.fleet_identities i where i.driver_id=target and i.source='bolt' and i.organization_id=p_org and not i.provisional
    and i.external_id=coverage->>'provider_driver_id') then raise exception 'Unknown or changed provider identity';end if;
 end loop;
 for entry in select value from jsonb_array_elements(p_rows) loop
  target:=(entry->>'driver_id')::uuid;
  if not exists(select 1 from jsonb_array_elements(p_coverage) c where c->>'driver_id'=entry->>'driver_id' and c->>'provider_driver_id'=entry->>'provider_driver_id')
   or coalesce(length(entry->>'external_id'),0) not between 1 and 160 or coalesce(entry->>'status','') not in('rider_cancelled','driver_did_not_respond','driver_rejected','rider_did_not_show','finished','driver_cancelled_after_accept')
   or entry->>'requested_at' is null or jsonb_typeof(entry->'stops') is distinct from 'array' or jsonb_array_length(entry->'stops')>30
   or entry->>'currency' is not null and entry->>'currency' !~ '^[A-Z]{3}$' then raise exception 'Invalid ride';end if;
  if exists(select 1 from jsonb_array_elements(entry->'stops') s where s->>'type' not in('pickup','dropoff','waypoint')
    or s->>'lat' is null or s->>'lng' is null or (s->>'lat')::numeric not between -90 and 90 or (s->>'lng')::numeric not between -180 and 180
    or exists(select 1 from jsonb_object_keys(s) k where k not in('type','lat','lng','arrived_at','departed_at'))) then raise exception 'Invalid stop';end if;
  insert into public.fleet_rides(source,organization_id,external_id,driver_id,status,started_at,finished_at,distance_km,duration_s,amount,currency,received_at,
   requested_at,accepted_at,pickup_duration_s,passenger_distance_km,tip_amount,booking_fee,toll_fee,cancellation_fee,stops,provider_driver_id,detail_origin,is_optional)
  values('bolt',p_org,entry->>'external_id',target,entry->>'status',(entry->>'started_at')::timestamptz,(entry->>'finished_at')::timestamptz,
   (entry->>'distance_km')::numeric,(entry->>'duration_s')::numeric,(entry->>'amount')::numeric,entry->>'currency',p_at,
   (entry->>'requested_at')::timestamptz,(entry->>'accepted_at')::timestamptz,(entry->>'pickup_duration_s')::numeric,(entry->>'passenger_distance_km')::numeric,
   (entry->>'tip_amount')::numeric,(entry->>'booking_fee')::numeric,(entry->>'toll_fee')::numeric,(entry->>'cancellation_fee')::numeric,
   entry->'stops',entry->>'provider_driver_id','bolt_api',(entry->>'is_optional')::boolean)
  on conflict(source,organization_id,external_id) do update set driver_id=excluded.driver_id,status=excluded.status,started_at=excluded.started_at,
   finished_at=excluded.finished_at,distance_km=excluded.distance_km,duration_s=excluded.duration_s,amount=excluded.amount,currency=excluded.currency,received_at=excluded.received_at,
   requested_at=excluded.requested_at,accepted_at=excluded.accepted_at,pickup_duration_s=excluded.pickup_duration_s,passenger_distance_km=excluded.passenger_distance_km,
   tip_amount=excluded.tip_amount,booking_fee=excluded.booking_fee,toll_fee=excluded.toll_fee,cancellation_fee=excluded.cancellation_fee,stops=excluded.stops,
   provider_driver_id=excluded.provider_driver_id,detail_origin=excluded.detail_origin,is_optional=excluded.is_optional where fleet_rides.received_at<=excluded.received_at;
  n:=n+1;
 end loop;
 for coverage in select value from jsonb_array_elements(p_coverage) loop
  target:=(coverage->>'driver_id')::uuid;f:=(coverage->>'from_at')::timestamptz;t:=(coverage->>'to_at')::timestamptz;
  insert into public.fleet_driver_performance_sync as s(source,organization_id,driver_id,covered_from,covered_to,last_attempt_at,last_success_at,status,row_count,last_error)
  values('bolt',p_org,target,f,t,p_at,p_at,'healthy',(select count(*) from jsonb_array_elements(p_rows) r where r->>'driver_id'=target::text),null)
  on conflict(source,organization_id,driver_id) do update set
   covered_from=case when s.covered_from<=excluded.covered_to and s.covered_to>=excluded.covered_from then least(s.covered_from,excluded.covered_from) else excluded.covered_from end,
   covered_to=case when s.covered_from<=excluded.covered_to and s.covered_to>=excluded.covered_from then greatest(s.covered_to,excluded.covered_to) else excluded.covered_to end,
   last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,status='healthy',row_count=excluded.row_count,last_error=null
   where s.last_success_at is null or s.last_success_at<=excluded.last_success_at;
 end loop;
 return jsonb_build_object('imported',n,'drivers',jsonb_array_length(p_coverage));
end $$;
revoke all on function public.fleet_import_bolt_performance(text,jsonb,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.fleet_import_bolt_performance(text,jsonb,jsonb,timestamptz) to service_role;
