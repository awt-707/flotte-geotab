-- Staging only: demand analysis, operational rush windows and moderated events.
create function public.ops_can_read_agency(p_agency bigint) returns boolean
language sql stable security definer set search_path=public as $$
 select public.is_admin() or (public.my_role() in ('manager','viewer') and p_agency=any(public.my_agency_ids()))
$$;
revoke all on function public.ops_can_read_agency(bigint) from public,anon;
grant execute on function public.ops_can_read_agency(bigint) to authenticated,service_role;

create table public.ops_demand_imports (
 id uuid primary key default gen_random_uuid(), agency_id bigint not null references public.agencies(id),
 city text not null check(city in ('Casablanca','Marrakech')), file_name text not null check(length(file_name)<=200),
 fingerprint text not null check(length(fingerprint)=64), counts jsonb not null default '{}',
 created_at timestamptz not null default now(), unique(agency_id,fingerprint)
);
create table public.ops_demand_rides (
 agency_id bigint not null references public.agencies(id), ride_key text not null check(length(ride_key)=64),
 import_id uuid not null references public.ops_demand_imports(id), city text not null check(city in ('Casablanca','Marrakech')),
 external_id text, started_at timestamptz not null, pickup_zone text not null check(length(pickup_zone) between 1 and 200),
 status text not null check(status in ('completed','cancelled')), primary key(agency_id,ride_key)
);
create index ops_demand_rides_period on public.ops_demand_rides(agency_id,started_at);
create table public.ops_rush_rules (
 id uuid primary key default gen_random_uuid(), agency_id bigint not null references public.agencies(id),
 city text not null check(city in ('Casablanca','Marrakech')), days jsonb not null,
 start text not null check(start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 "end" text not null check("end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 label text not null default '' check(length(label)<=100), enabled boolean not null default true, created_at timestamptz not null default now(), check(start<>"end"),
 check(jsonb_typeof(days)='array' and jsonb_array_length(days) between 1 and 7)
);
create table public.ops_event_sources (
 id text primary key, name text not null, url text not null, enabled boolean not null default true,
 status text not null default 'pending', last_attempt_at timestamptz, last_success_at timestamptz,
 last_error text, received_count integer not null default 0
);
insert into public.ops_event_sources(id,name,url) values
 ('if-maroc','Institut français du Maroc','https://if-maroc.org/evenements/');
insert into public.ops_event_sources(id,name,url,enabled,status) values ('manual','Agence','',false,'manual');
create table public.ops_events (
 id uuid primary key default gen_random_uuid(), source_id text not null references public.ops_event_sources(id),
 external_key text not null, source_url text not null, city text not null check(city in ('Casablanca','Marrakech')),
 title text not null check(length(title) between 1 and 240), place text not null default '' check(length(place)<=240),
 starts_at timestamptz, ends_at timestamptz, source_date_text text not null default '',
 time_precision text not null default 'unknown' check(time_precision in ('minute','day','unknown')),
 fingerprint text not null, status text not null default 'pending' check(status in ('pending','approved','rejected')),
 observed_at timestamptz not null, reviewed_at timestamptz, reviewed_by uuid references auth.users(id),
 unique(source_id,external_key), check(ends_at is null or starts_at is not null and ends_at>=starts_at)
);
create table public.ops_event_reviews (
 id bigint generated always as identity primary key, event_id uuid not null references public.ops_events(id),
 decision text not null check(decision in ('approved','rejected')), fingerprint text not null,
 reviewed_by uuid not null references auth.users(id), reviewed_at timestamptz not null default now()
);
create table public.ops_fuel_settings (
 id integer primary key check(id=1), enabled boolean not null default true,
 excess_pct numeric not null default 30 check(excess_pct between 5 and 200),
 min_distance_km numeric not null default 10 check(min_distance_km between 5 and 100),
 cooldown_minutes integer not null default 60 check(cooldown_minutes between 15 and 1440)
);
insert into public.ops_fuel_settings(id) values(1);
create table public.ops_fuel_checkpoints (
 vehicle_key text primary key references public.vehicles(key) on delete cascade,
 state jsonb not null, updated_at timestamptz not null default now()
);

do $$ declare t text; begin
 foreach t in array array['ops_demand_imports','ops_demand_rides','ops_rush_rules','ops_event_sources','ops_events','ops_event_reviews','ops_fuel_settings','ops_fuel_checkpoints'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
 foreach t in array array['ops_demand_imports','ops_demand_rides','ops_rush_rules'] loop
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy read_scope on public.%I for select to authenticated using(public.ops_can_read_agency(agency_id))',t);
 end loop;
 foreach t in array array['ops_event_sources','ops_events','ops_event_reviews','ops_fuel_settings'] loop
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy staff_read on public.%I for select to authenticated using(public.my_role() in (''admin'',''manager'',''viewer''))',t);
 end loop;
end $$;
grant usage,select on sequence public.ops_event_reviews_id_seq to service_role;

create function public.ops_import_demand(p_import jsonb,p_rows jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare imported uuid; added integer; agency bigint:=(p_import->>'agency_id')::bigint;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>20000 or jsonb_array_length(p_rows)=0 then raise exception 'Invalid import';end if;
 insert into public.ops_demand_imports(agency_id,city,file_name,fingerprint,counts)
 values(agency,p_import->>'city',p_import->>'file_name',p_import->>'fingerprint',p_import->'counts')
 on conflict(agency_id,fingerprint) do nothing returning id into imported;
 if imported is null then return jsonb_build_object('duplicate',true,'inserted',0);end if;
 insert into public.ops_demand_rides(agency_id,ride_key,import_id,city,external_id,started_at,pickup_zone,status)
 select agency,x.ride_key,imported,p_import->>'city',x.external_id,x.started_at,x.pickup_zone,x.status
 from jsonb_to_recordset(p_rows) as x(ride_key text,external_id text,started_at timestamptz,pickup_zone text,status text)
 on conflict(agency_id,ride_key) do update set import_id=excluded.import_id,city=excluded.city,started_at=excluded.started_at,pickup_zone=excluded.pickup_zone,status=excluded.status;
 get diagnostics added=row_count;
 return jsonb_build_object('duplicate',false,'import_id',imported,'inserted',added);
end $$;
revoke all on function public.ops_import_demand(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.ops_import_demand(jsonb,jsonb) to service_role;

create function public.ops_ingest_events(p_source text,p_rows jsonb,p_at timestamptz) returns integer
language plpgsql security definer set search_path=public as $$
declare n integer;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>200 then raise exception 'Invalid event batch';end if;
 insert into public.ops_events(source_id,external_key,source_url,city,title,place,starts_at,ends_at,source_date_text,time_precision,fingerprint,observed_at)
 select p_source,x.external_key,x.source_url,x.city,x.title,x.place,x.starts_at,x.ends_at,x.source_date_text,x.time_precision,x.fingerprint,p_at
 from jsonb_to_recordset(p_rows) as x(external_key text,source_url text,city text,title text,place text,starts_at timestamptz,ends_at timestamptz,source_date_text text,time_precision text,fingerprint text)
 on conflict(source_id,external_key) do update set title=excluded.title,city=excluded.city,place=excluded.place,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
  source_date_text=excluded.source_date_text,time_precision=excluded.time_precision,source_url=excluded.source_url,observed_at=excluded.observed_at,
  status=case when public.ops_events.fingerprint=excluded.fingerprint then public.ops_events.status else 'pending' end,
  reviewed_at=case when public.ops_events.fingerprint=excluded.fingerprint then public.ops_events.reviewed_at else null end,
  reviewed_by=case when public.ops_events.fingerprint=excluded.fingerprint then public.ops_events.reviewed_by else null end,fingerprint=excluded.fingerprint;
 get diagnostics n=row_count;return n;
end $$;
revoke all on function public.ops_ingest_events(text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.ops_ingest_events(text,jsonb,timestamptz) to service_role;

create function public.ops_review_event(p_id uuid,p_fingerprint text,p_decision text,p_user uuid) returns boolean
language plpgsql security definer set search_path=public as $$
declare event public.ops_events;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
 if p_decision is null or p_decision not in ('approved','rejected') or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
  or not exists(select 1 from public.profiles where user_id=p_user and role='admin') then raise exception 'Review refused';end if;
 select * into event from public.ops_events where id=p_id for update;
 if not found or event.fingerprint<>p_fingerprint then raise exception 'Event changed: reload before review';end if;
 if p_decision='approved' and event.starts_at is null then raise exception 'Date required before approval';end if;
 update public.ops_events set status=p_decision,reviewed_by=p_user,reviewed_at=now() where id=p_id;
 insert into public.ops_event_reviews(event_id,decision,fingerprint,reviewed_by) values(p_id,p_decision,p_fingerprint,p_user);
 return true;
end $$;
revoke all on function public.ops_review_event(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.ops_review_event(uuid,text,text,uuid) to service_role;
