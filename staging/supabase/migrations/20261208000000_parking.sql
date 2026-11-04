do $$ begin if(select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;end $$;
create table public.fleet_parking_zones (
 id uuid primary key default gen_random_uuid(),name text not null check(length(name) between 1 and 120),
 kind text not null default 'parking' check(kind in('parking','exclusion')),agency_id bigint references public.agencies(id),shape jsonb not null check(jsonb_typeof(shape)='object' and pg_column_size(shape)<65536),
 enabled boolean not null default true,fingerprint text not null check(fingerprint~'^[a-f0-9]{64}$'),
 source text not null default 'manual' check(source in('manual','geotab')),source_id text,
 updated_at timestamptz not null default now(),revision bigint not null default 1 check(revision>0),unique(source,source_id)
);
create table public.fleet_parking_state (
 vehicle_key text not null references public.vehicles(key) on delete cascade,
 zone_id uuid not null references public.fleet_parking_zones(id),state jsonb not null check(pg_column_size(state)<8192),updated_at timestamptz not null default now(),primary key(vehicle_key,zone_id)
);
create table public.fleet_parking_events (
 event_key text primary key check(event_key~'^[a-f0-9]{64}$'),vehicle_key text not null references public.vehicles(key),
 zone_id uuid not null references public.fleet_parking_zones(id),kind text not null check(kind in('entered','exited')),
 observed_at timestamptz not null,first_observed_at timestamptz not null,check(first_observed_at<=observed_at)
);
create index fleet_parking_events_time on public.fleet_parking_events(observed_at desc);
do $$ declare t text;begin
 foreach t in array array['fleet_parking_zones','fleet_parking_state','fleet_parking_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
create policy read_staff on public.fleet_parking_zones for select to authenticated using(public.my_role() in('admin','manager','viewer'));
create policy read_vehicle on public.fleet_parking_state for select to authenticated using(public.is_admin() or vehicle_key=any(public.my_vehicle_keys()));
create policy read_vehicle on public.fleet_parking_events for select to authenticated using(public.is_admin() or vehicle_key=any(public.my_vehicle_keys()));
-- A configuration change starts a new observation interval. Historical events
-- stay intact; re-enabling a zone never resumes its old pending transition.
create function public.fleet_parking_zone_reset() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if(select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 new.revision:=old.revision+1;
 delete from public.fleet_parking_state where zone_id=old.id;
 return new;
end $$;
revoke all on function public.fleet_parking_zone_reset() from public,anon,authenticated;
create trigger fleet_parking_zone_reset before update on public.fleet_parking_zones for each row execute function public.fleet_parking_zone_reset();

create function public.fleet_commit_parking(p_states jsonb,p_events jsonb) returns void language plpgsql security definer set search_path=public as $$
declare row jsonb; current_zone public.fleet_parking_zones; old_state jsonb; device text; has_old boolean; state_time timestamptz;
begin
 if(select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 if jsonb_typeof(p_states) is distinct from 'array' or jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_states)>1000 or jsonb_array_length(p_events)>1000 then raise exception 'Invalid parking batch';end if;
 if exists(select 1 from jsonb_array_elements(p_states) r group by r->>'vehicle_key',r->>'zone_id' having count(*)>1) then raise exception 'Duplicate parking state';end if;
 for row in select value from jsonb_array_elements(p_states) order by value->>'zone_id',value->>'vehicle_key' loop
  select * into current_zone from public.fleet_parking_zones where id=(row->>'zone_id')::uuid for share;
  if not found or not current_zone.enabled or current_zone.revision is distinct from (row->>'zone_revision')::bigint then raise exception 'Parking configuration changed';end if;
  select geotab_id into device from public.vehicles where key=row->>'vehicle_key' for share;
  if not found then raise exception 'Unknown parking vehicle';end if;
  select state into old_state from public.fleet_parking_state where vehicle_key=row->>'vehicle_key' and zone_id=current_zone.id for update;has_old:=found;
  if has_old and (old_state->>'last_at')::timestamptz is distinct from (row->>'previous_at')::timestamptz and old_state is distinct from row->'state' then raise exception 'Parking observation changed';end if;
  if not has_old and row->>'previous_at' is not null and row->'state'<>'null'::jsonb then raise exception 'Parking interval reset';end if;
  if jsonb_typeof(row->'state')='object' then
   state_time:=(row->'state'->>'last_at')::timestamptz;
   if state_time is null or not isfinite(state_time) or state_time>clock_timestamp()+interval '5 seconds'
    or row->'state'->>'device_id' is distinct from device or device is null
    or (row->'state'->>'zone_revision')::bigint is distinct from current_zone.revision
    or row->'state'->>'zone_id' is not null and row->'state'->>'zone_id'<>current_zone.id::text
    or has_old and state_time<(old_state->>'last_at')::timestamptz then raise exception 'Invalid parking observation';end if;
  elsif row->'state' is distinct from 'null'::jsonb then raise exception 'Invalid parking state';end if;
  if row->'state'='null'::jsonb then delete from public.fleet_parking_state where vehicle_key=row->>'vehicle_key' and zone_id=(row->>'zone_id')::uuid;
  else insert into public.fleet_parking_state(vehicle_key,zone_id,state,updated_at) values(row->>'vehicle_key',(row->>'zone_id')::uuid,row->'state',now())
   on conflict(vehicle_key,zone_id) do update set state=excluded.state,updated_at=excluded.updated_at;end if;
 end loop;
 for row in select value from jsonb_array_elements(p_events) loop
  if not exists(select 1 from jsonb_array_elements(p_states) s where s->>'vehicle_key'=row->>'vehicle_key' and s->>'zone_id'=row->>'zone_id'
    and (s->'state'->>'last_at')::timestamptz=(row->>'observed_at')::timestamptz
    and (row->>'kind'='entered' and s->'state'->>'zone_id'=row->>'zone_id' or row->>'kind'='exited' and s->'state'->>'zone_id' is null))
   or (row->>'observed_at')::timestamptz-(row->>'first_observed_at')::timestamptz<interval '5 seconds' then raise exception 'Unconfirmed parking event';end if;
  insert into public.fleet_parking_events(event_key,vehicle_key,zone_id,kind,observed_at,first_observed_at)
  values(row->>'event_key',row->>'vehicle_key',(row->>'zone_id')::uuid,row->>'kind',(row->>'observed_at')::timestamptz,(row->>'first_observed_at')::timestamptz)
  on conflict(event_key) do nothing;
 end loop;
end $$;
revoke all on function public.fleet_commit_parking(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fleet_commit_parking(jsonb,jsonb) to service_role;
