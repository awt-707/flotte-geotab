-- Local staging only. Historical references carry their measured evidence.
do $$ begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required'; end if;
end $$;
alter table public.vehicles add column fuel_reference_evidence jsonb;
create table public.ops_fuel_reference_runs (
 id integer primary key check(id=1), status text not null default 'pending' check(status in ('pending','reading','complete','waiting')),
 last_attempt_at timestamptz,last_success_at timestamptz,next_attempt_at timestamptz,last_error text,
 candidates integer not null default 0,applied integer not null default 0,insufficient integer not null default 0
);
insert into public.ops_fuel_reference_runs(id) values(1);
alter table public.ops_fuel_reference_runs enable row level security;
revoke all on public.ops_fuel_reference_runs from public,anon,authenticated;
grant all on public.ops_fuel_reference_runs to service_role;
create function public.ops_set_measured_fuel_reference(p_vehicle text,p_device text,p_reference jsonb) returns boolean
language plpgsql security definer set search_path=public as $$
declare changed integer; reference_value numeric; distance numeric; litres numeric; start_at timestamptz; end_at timestamptz;
 boundary text; expected_at timestamptz; km_at timestamptz; fuel_at timestamptz;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required'; end if;
 reference_value:=(p_reference->>'value')::numeric;distance:=(p_reference->>'distance_km')::numeric;litres:=(p_reference->>'fuel_l')::numeric;
 start_at:=(p_reference->>'from')::timestamptz;end_at:=(p_reference->>'to')::timestamptz;
 if jsonb_typeof(p_reference) is distinct from 'object' or pg_column_size(p_reference)>8192
  or p_reference->>'method' is distinct from 'geotab_history' or reference_value is null or reference_value not between 1 and 40
  or reference_value::text in ('NaN','Infinity','-Infinity') or distance::text in ('NaN','Infinity','-Infinity') or litres::text in ('NaN','Infinity','-Infinity')
  or distance is null or distance<100 or litres is null or litres<=0 or abs(round(100*litres/distance,1)-reference_value)>0.01
  or start_at is null or end_at is null or not isfinite(start_at) or not isfinite(end_at) or end_at>now() or end_at-start_at not between interval '167 hours' and interval '169 hours'
  or distance/extract(epoch from end_at-start_at)*3600>160
  then raise exception 'Invalid measured reference';end if;
 foreach boundary in array array['from','to'] loop
  expected_at:=case when boundary='from' then start_at else end_at end;
  km_at:=(p_reference->'counter_at'->'km'->>boundary)::timestamptz;
  fuel_at:=(p_reference->'counter_at'->'fuel_l'->>boundary)::timestamptz;
  if km_at is null or fuel_at is null or not isfinite(km_at) or not isfinite(fuel_at)
   or km_at>expected_at or fuel_at>expected_at or expected_at-km_at>interval '5 minutes' or expected_at-fuel_at>interval '5 minutes'
   then raise exception 'Invalid measured counter timestamps';end if;
 end loop;
 update public.vehicles set ref_l100=reference_value,fuel_reference_evidence=p_reference||jsonb_build_object('geotab_id',p_device)
 where key=p_vehicle and geotab_id=p_device and ref_l100 is null and coalesce(upper(active),'OUI') not in ('NON','FALSE');
 get diagnostics changed=row_count;return changed=1;
end $$;
revoke all on function public.ops_set_measured_fuel_reference(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.ops_set_measured_fuel_reference(text,text,jsonb) to service_role;
