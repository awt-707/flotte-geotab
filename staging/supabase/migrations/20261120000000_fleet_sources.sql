-- Local staging only. Independent from Geotab alerts/replace_alerts.
create table public.fleet_sources (
  id text primary key check (id in ('uber','bolt','geotab','myclicar')),
  name text not null, status text not null default 'unconnected',
  last_success_at timestamptz, last_attempt_at timestamptz, last_error text,
  stale_after_s integer not null default 90 check (stale_after_s between 15 and 3600),
  coverage jsonb not null default '{}', metadata jsonb not null default '{}'
);
insert into public.fleet_sources(id,name,stale_after_s) values
 ('uber','Uber Fleet · écran visible',45),('bolt','Bolt Fleet API',150),
 ('geotab','Geotab',90),('myclicar','MyClicar',300);
create table public.fleet_drivers (
  id uuid primary key default gen_random_uuid(), name text not null,
  ludy_driver_code text references public.drivers(code) on delete set null,
  vehicle_key text references public.vehicles(key) on delete set null,
  agency_id bigint references public.agencies(id) on delete set null,
  created_at timestamptz not null default now()
);
create table public.fleet_identities (
  id uuid primary key default gen_random_uuid(), driver_id uuid not null references public.fleet_drivers(id) on delete cascade,
  source text not null references public.fleet_sources(id), source_key text not null,
  external_id text, organization_id text, provisional boolean not null default false,
  unique(source,source_key)
);
create table public.fleet_observations (
  id bigint generated always as identity primary key,
  driver_id uuid not null references public.fleet_drivers(id) on delete cascade,
  identity_id uuid not null references public.fleet_identities(id) on delete cascade,
  source text not null references public.fleet_sources(id),
  status text not null check(status in ('available','on_trip','to_pickup','offline','unknown','on_break')),
  observed_at timestamptz not null, received_at timestamptz not null default now(),
  source_at timestamptz, event_at timestamptz, vehicle_label text, evidence jsonb not null default '{}',
  unique(identity_id,observed_at)
);
create index fleet_observations_history on public.fleet_observations(driver_id,source,observed_at);
create table public.fleet_latest (
  identity_id uuid primary key references public.fleet_identities(id) on delete cascade,
  driver_id uuid not null references public.fleet_drivers(id) on delete cascade,
  source text not null references public.fleet_sources(id), status text not null,
  observed_at timestamptz not null, received_at timestamptz not null,
  source_at timestamptz, event_at timestamptz, vehicle_label text, evidence jsonb not null default '{}',
  offline_since timestamptz, offline_samples integer not null default 0,
  recovery_samples integer not null default 0
);
create table public.fleet_source_events (
 id bigint generated always as identity primary key, source text not null references public.fleet_sources(id),
 status text not null, at timestamptz not null default now(), detail text
);
create index fleet_source_events_time on public.fleet_source_events(source,at);
create table public.fleet_alerts (
 id uuid primary key default gen_random_uuid(), driver_id uuid not null references public.fleet_drivers(id) on delete cascade,
 identity_id uuid not null references public.fleet_identities(id) on delete cascade,
 source text not null references public.fleet_sources(id),
 kind text not null default 'offline_threshold', status text not null default 'open' check(status in ('open','resolved','suspended')),
 opened_at timestamptz not null default now(), observed_since timestamptz not null,
 resolved_at timestamptz, last_seen_at timestamptz not null default now(), threshold_s integer not null,
 rule text not null, unique(identity_id,observed_since)
);
create unique index fleet_one_open_alert on public.fleet_alerts(identity_id) where status='open';
create table public.fleet_settings (
 id integer primary key check(id=1), offline_threshold_s integer not null default 300 check(offline_threshold_s between 60 and 86400),
 schedule jsonb, enabled boolean not null default true
);
insert into public.fleet_settings(id) values(1);
create table public.fleet_provider_vehicles (
 source text not null references public.fleet_sources(id), organization_id text not null, external_id text not null,
 plate text, make text, model text, status text, received_at timestamptz not null default now(),
 primary key(source,organization_id,external_id)
);
create table public.fleet_rides (
 source text not null references public.fleet_sources(id), organization_id text not null, external_id text not null,
 driver_id uuid references public.fleet_drivers(id) on delete set null, status text,
 started_at timestamptz, finished_at timestamptz, distance_km numeric, duration_s numeric, amount numeric, currency text,
 received_at timestamptz not null default now(), primary key(source,organization_id,external_id)
);
create or replace function public.fleet_can_read(p_driver uuid) returns boolean
 language sql stable security definer set search_path=public as $$
 select public.is_admin() or (public.my_role() in ('manager','viewer') and exists(
   select 1 from fleet_drivers d where d.id=p_driver and d.agency_id=any(public.my_agency_ids())
 )) $$;
revoke all on function public.fleet_can_read(uuid) from public,anon;
grant execute on function public.fleet_can_read(uuid) to authenticated,service_role;
do $$ declare t text; begin
 foreach t in array array['fleet_sources','fleet_drivers','fleet_identities','fleet_observations','fleet_latest','fleet_source_events','fleet_alerts','fleet_settings','fleet_provider_vehicles','fleet_rides'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from anon,authenticated',t);
   execute format('grant select on public.%I to authenticated',t);
   execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
grant usage,select on sequence public.fleet_observations_id_seq, public.fleet_source_events_id_seq to service_role;
create policy read_scope on public.fleet_drivers for select to authenticated using(public.fleet_can_read(id));
create policy read_scope on public.fleet_identities for select to authenticated using(public.fleet_can_read(driver_id));
create policy read_scope on public.fleet_observations for select to authenticated using(public.fleet_can_read(driver_id));
create policy read_scope on public.fleet_latest for select to authenticated using(public.fleet_can_read(driver_id));
create policy read_scope on public.fleet_alerts for select to authenticated using(public.fleet_can_read(driver_id));
create policy read_scope on public.fleet_rides for select to authenticated using(public.fleet_can_read(driver_id));
-- Source metadata may include companies outside an agency's scope. The local API returns
-- only sanitized health summaries to non-admins; direct source metadata access is admin-only.
create policy read_admin on public.fleet_sources for select to authenticated using(public.is_admin());
create policy read_validated on public.fleet_source_events for select to authenticated using(public.my_role() in ('admin','manager','viewer'));
create policy read_validated on public.fleet_settings for select to authenticated using(public.my_role() in ('admin','manager','viewer'));
create policy read_admin on public.fleet_provider_vehicles for select to authenticated using(public.is_admin());
