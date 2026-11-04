-- Local staging only. Historical reports never alter current vehicle assignment.
do $$ begin if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;end $$;
alter table public.fleet_rides add column provider_vehicle_id text,add column vehicle_label text;
create table public.fleet_driver_report_summaries (
 source text not null default 'uber' check(source='uber'),organization_id text not null,
 driver_id uuid not null references public.fleet_drivers(id) on delete cascade,
 report_type text not null check(report_type in('driver_activity','driver_quality')),
 period_from timestamptz not null,period_to timestamptz not null,reported_at timestamptz not null default now(),
 trips_completed integer check(trips_completed>=0),online_seconds numeric check(online_seconds>=0),trip_seconds numeric check(trip_seconds>=0),
 acceptance_rate numeric check(acceptance_rate between 0 and 1),cancellation_rate numeric check(cancellation_rate between 0 and 1),completion_rate numeric check(completion_rate between 0 and 1),
 accepted_count integer check(accepted_count>=0),rejected_count integer check(rejected_count>=0),cancelled_count integer check(cancelled_count>=0),
 primary key(source,organization_id,driver_id,report_type,period_from,period_to),check(period_to>period_from)
);
alter table public.fleet_driver_report_summaries enable row level security;
revoke all on public.fleet_driver_report_summaries from public,anon,authenticated;
grant select on public.fleet_driver_report_summaries to authenticated;
grant all on public.fleet_driver_report_summaries to service_role;
create policy staff_driver_scope on public.fleet_driver_report_summaries for select to authenticated
 using(public.my_role() in('admin','manager','viewer') and public.fleet_can_read(driver_id));
create index fleet_driver_report_period on public.fleet_driver_report_summaries(driver_id,source,period_from,period_to);

create table public.uber_driver_report_imports (
 organization_id uuid not null,config_revision bigint not null,report_type text not null check(report_type in('trip_activity','driver_activity','driver_quality')),
 file_sha256 text not null check(file_sha256 ~ '^[a-f0-9]{64}$'),period_from timestamptz not null,period_to timestamptz not null,
 counts jsonb not null,created_at timestamptz not null default now(),last_received_at timestamptz not null default now(),
 primary key(organization_id,config_revision,report_type,file_sha256,period_from,period_to),check(period_to>period_from),check(pg_column_size(counts)<=16384)
);
alter table public.uber_driver_report_imports enable row level security;
revoke all on public.uber_driver_report_imports from public,anon,authenticated;
grant all on public.uber_driver_report_imports to service_role;
create index uber_driver_report_recent on public.uber_driver_report_imports(last_received_at desc);

create function public.uber_report_driver(p_org text,p_provider text,p_name text,p_mapping jsonb) returns uuid
language plpgsql stable security definer set search_path=public as $$
declare candidates uuid[];name_key text;
begin
 if p_provider is not null then
  select array_agg(distinct d.id) into candidates from public.fleet_identities i join public.fleet_drivers d on d.id=i.driver_id
   where i.source='uber' and lower(i.organization_id)=p_org and not i.provisional and lower(i.external_id)=lower(p_provider);
 else
  name_key:=lower(regexp_replace(btrim(coalesce(p_name,'')),'[[:space:]-]+',' ','g'));
  if length(name_key)<5 or name_key!~'[[:alpha:]] [[:alpha:]]' then return null;end if;
  select array_agg(distinct d.id) into candidates from public.fleet_identities i join public.fleet_drivers d on d.id=i.driver_id
   where i.source='uber' and lower(i.organization_id)=p_org
    and lower(regexp_replace(btrim(d.name),'[[:space:]-]+',' ','g'))=name_key;
 end if;
 if cardinality(candidates)=1 and exists(select 1 from public.fleet_drivers where id=candidates[1] and agency_id in(select value::text::bigint from jsonb_each(p_mapping))) then return candidates[1];end if;return null;
end $$;
revoke all on function public.uber_report_driver(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.uber_report_driver(text,text,text,jsonb) to service_role;

create function public.uber_driver_report_commit(p_org uuid,p_revision bigint,p_hash text,p_type text,p_batches jsonb,p_rows jsonb,p_counts jsonb,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare config public.uber_report_settings;entry jsonb;target uuid;matched integer:=0;unmatched integer:=0;duplicate boolean;counts jsonb;demand jsonb;seen uuid[]:='{}';
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 select * into config from public.uber_report_settings where id=1 for update;
 if not config.enabled or config.organization_id is distinct from p_org or config.revision is distinct from p_revision then raise exception 'Report configuration changed';end if;
 if p_type is null or p_type not in('trip_activity','driver_activity','driver_quality') or p_hash is null or p_hash!~'^[a-f0-9]{64}$'
  or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>20000 or jsonb_typeof(p_batches) is distinct from 'array'
  or jsonb_typeof(p_counts) is distinct from 'object' or pg_column_size(p_counts)>16384
  or p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_to<=p_from or p_to-p_from>interval '7 days 1 hour' or p_to>now()+interval '5 minutes'
  or p_type<>'trip_activity' and jsonb_array_length(p_batches)<>0 then raise exception 'Invalid Uber report';end if;
 if p_type='trip_activity' and exists(select 1 from jsonb_array_elements(p_rows) r group by r->>'external_id' having count(*)>1) then raise exception 'Duplicate trip';end if;
 select exists(select 1 from public.uber_driver_report_imports where organization_id=p_org and config_revision=p_revision and report_type=p_type and file_sha256=p_hash and period_from=p_from and period_to=p_to) into duplicate;
 for entry in select value from jsonb_array_elements(p_rows) loop
  if jsonb_typeof(entry) is distinct from 'object' or length(coalesce(entry->>'driver_name',''))>160
   or entry->>'provider_driver_id' is not null and entry->>'provider_driver_id'!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then raise exception 'Invalid Uber identity';end if;
  target:=public.uber_report_driver(p_org::text,entry->>'provider_driver_id',entry->>'driver_name',config.city_agencies);
  if target is null then unmatched:=unmatched+1;continue;end if;
  if p_type='trip_activity' then
   if coalesce(entry->>'external_id','')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' or coalesce(entry->>'status','') not in('completed','rider_cancelled','driver_cancelled','cancelled')
    or entry->>'requested_at' is null or (entry->>'requested_at')::timestamptz<p_from or (entry->>'requested_at')::timestamptz>=p_to
    or (entry->>'finished_at')::timestamptz<coalesce((entry->>'started_at')::timestamptz,(entry->>'requested_at')::timestamptz)
    or (entry->>'started_at')::timestamptz<(entry->>'requested_at')::timestamptz or (entry->>'finished_at')::timestamptz>now()+interval '5 minutes'
    or (entry->>'distance_km')::numeric<0 or (entry->>'distance_km')::numeric>1000000 or length(coalesce(entry->>'vehicle_label',''))>40 then raise exception 'Invalid Uber ride';end if;
   insert into public.fleet_rides(source,organization_id,external_id,driver_id,status,requested_at,started_at,finished_at,distance_km,provider_driver_id,provider_vehicle_id,vehicle_label,detail_origin)
   values('uber',p_org::text,entry->>'external_id',target,entry->>'status',(entry->>'requested_at')::timestamptz,(entry->>'started_at')::timestamptz,(entry->>'finished_at')::timestamptz,(entry->>'distance_km')::numeric,entry->>'provider_driver_id',entry->>'provider_vehicle_id',entry->>'vehicle_label','uber_report')
   on conflict(source,organization_id,external_id) do update set driver_id=excluded.driver_id,status=excluded.status,requested_at=excluded.requested_at,started_at=excluded.started_at,
    finished_at=excluded.finished_at,distance_km=excluded.distance_km,provider_driver_id=excluded.provider_driver_id,provider_vehicle_id=excluded.provider_vehicle_id,vehicle_label=excluded.vehicle_label,detail_origin='uber_report',received_at=now();
  else
   if target=any(seen) then raise exception 'Two report rows map to the same driver';end if;seen:=array_append(seen,target);
   if (entry->>'online_seconds')::numeric>extract(epoch from p_to-p_from) or (entry->>'trip_seconds')::numeric>extract(epoch from p_to-p_from) then raise exception 'Invalid report duration';end if;
   insert into public.fleet_driver_report_summaries(source,organization_id,driver_id,report_type,period_from,period_to,trips_completed,online_seconds,trip_seconds,acceptance_rate,cancellation_rate,completion_rate,accepted_count,rejected_count,cancelled_count)
   values('uber',p_org::text,target,p_type,p_from,p_to,(entry->>'trips_completed')::integer,(entry->>'online_seconds')::numeric,(entry->>'trip_seconds')::numeric,(entry->>'acceptance_rate')::numeric,(entry->>'cancellation_rate')::numeric,(entry->>'completion_rate')::numeric,(entry->>'accepted_count')::integer,(entry->>'rejected_count')::integer,(entry->>'cancelled_count')::integer)
   on conflict(source,organization_id,driver_id,report_type,period_from,period_to) do update set reported_at=now(),trips_completed=excluded.trips_completed,online_seconds=excluded.online_seconds,trip_seconds=excluded.trip_seconds,
    acceptance_rate=excluded.acceptance_rate,cancellation_rate=excluded.cancellation_rate,completion_rate=excluded.completion_rate,accepted_count=excluded.accepted_count,rejected_count=excluded.rejected_count,cancelled_count=excluded.cancelled_count;
  end if;matched:=matched+1;
 end loop;
 counts:=p_counts||jsonb_build_object('driver_imported',matched,'driver_unmatched',unmatched);
 if p_type='trip_activity' then demand:=public.uber_report_commit(p_org,p_revision,p_hash,p_batches,counts);end if;
 insert into public.uber_driver_report_imports(organization_id,config_revision,report_type,file_sha256,period_from,period_to,counts)
 values(p_org,p_revision,p_type,p_hash,p_from,p_to,counts)
 on conflict(organization_id,config_revision,report_type,file_sha256,period_from,period_to) do update set counts=excluded.counts,last_received_at=now();
 update public.uber_report_settings set last_attempt_at=now(),last_success_at=now(),last_status=case when matched>0 or coalesce((counts->>'imported')::integer,0)>0 then 'imported' else 'empty' end,last_error=null,last_counts=counts||jsonb_build_object('report_type',p_type) where id=1;
 -- Raw names, CSV and addresses are not stored in the report journal.
 return jsonb_build_object('duplicate',duplicate,'counts',counts,'report_type',p_type,'results',coalesce(demand->'results','[]'::jsonb));
end $$;
revoke all on function public.uber_driver_report_commit(uuid,bigint,text,text,jsonb,jsonb,jsonb,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.uber_driver_report_commit(uuid,bigint,text,text,jsonb,jsonb,jsonb,timestamptz,timestamptz) to service_role;
