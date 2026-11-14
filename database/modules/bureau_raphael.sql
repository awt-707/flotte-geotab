-- =============================================================================
-- Module de l'application de bureau (Raphael) : objets de la production qui ne viennent pas des migrations de Ludy.
-- Copie exacte du catalogue de la production (2026-11-14), produite par « node database/outils/production.js extraire » :
-- ne pas modifier à la main. À installer après database/schema/ et database/liens_droits/ (même base).
-- Contenu : 50 tables, 68 fonctions, 15 déclencheurs, 3 colonnes ajoutées aux tables de Ludy.
-- Attention : ce module remplace aussi des fonctions de Ludy (section « Fonctions de Ludy remplacées ») : une migration de Ludy
-- qui les redéfinit efface la version de l'application de bureau, et inversement.
-- =============================================================================
set check_function_bodies = false;
set client_min_messages = warning;

-- ----------------------------------------------------------------------------- Colonnes ajoutées aux tables de Ludy
alter table public.vehicles add column if not exists myclicar_external_id text;
alter table public.vehicles add column if not exists geotab_auto_link_disabled boolean default false not null;
alter table public.vehicles add column if not exists fuel_reference_evidence jsonb;
alter table public.vehicles add constraint vehicles_myclicar_external_id_key UNIQUE (myclicar_external_id);

-- ----------------------------------------------------------------------------- Tables

create table public.desktop_vehicle_live (
  vehicle_key text not null,
  data jsonb not null,
  observed_at timestamp with time zone default clock_timestamp() not null
);

create table public.desktop_worker_devices (
  id uuid not null,
  owner_id uuid not null,
  label text not null,
  enabled boolean default false not null,
  created_at timestamp with time zone default clock_timestamp() not null,
  approved_at timestamp with time zone,
  updated_at timestamp with time zone default clock_timestamp() not null
);

create table public.desktop_worker_leases (
  scope text not null,
  device_id uuid,
  fence bigint default 0 not null,
  expires_at timestamp with time zone default '-infinity'::timestamp with time zone not null,
  updated_at timestamp with time zone default clock_timestamp() not null
);

create table public.driver_notifications (
  id uuid default gen_random_uuid() not null,
  account_id uuid not null,
  event_key text not null,
  kind text not null,
  title text not null,
  message text not null,
  observed_at timestamp with time zone not null,
  created_at timestamp with time zone default now() not null,
  acknowledged_at timestamp with time zone,
  evidence jsonb default '{}'::jsonb not null
);

create table public.driver_portal_accounts (
  id uuid default gen_random_uuid() not null,
  ludy_driver_code text not null,
  agency_id bigint,
  display_name text not null,
  credential_hash text not null,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  rotated_at timestamp with time zone default now() not null
);

create table public.driver_portal_sessions (
  token_hash text not null,
  account_id uuid not null,
  created_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone not null
);

create table public.driver_reports (
  id uuid default gen_random_uuid() not null,
  account_id uuid not null,
  category text not null,
  city text not null,
  place text not null,
  description text not null,
  status text default 'pending'::text not null,
  admin_note text default ''::text not null,
  reported_at timestamp with time zone default now() not null,
  reviewed_at timestamp with time zone,
  reviewed_by uuid
);

create table public.fleet_alerts (
  id uuid default gen_random_uuid() not null,
  driver_id uuid not null,
  identity_id uuid not null,
  source text not null,
  kind text default 'offline_threshold'::text not null,
  status text default 'open'::text not null,
  opened_at timestamp with time zone default now() not null,
  observed_since timestamp with time zone not null,
  resolved_at timestamp with time zone,
  last_seen_at timestamp with time zone default now() not null,
  threshold_s integer not null,
  rule text not null
);

create table public.fleet_contract_assignment_overrides (
  contract_id text not null,
  client_code text not null,
  vehicle_key text not null,
  effective_start_at timestamp with time zone not null,
  observed_at timestamp with time zone not null,
  evidence jsonb default '{}'::jsonb not null,
  latest_conflict_at timestamp with time zone default now() not null
);

create table public.fleet_disconnection_alerts (
  id uuid default gen_random_uuid() not null,
  identity_id uuid not null,
  driver_id uuid not null,
  source text not null,
  vehicle_key text,
  contract_id text,
  duty_key text not null,
  observed_online_at timestamp with time zone not null,
  disconnected_at timestamp with time zone not null,
  opened_at timestamp with time zone default now() not null,
  last_seen_at timestamp with time zone default now() not null,
  status text default 'open'::text not null,
  resolved_at timestamp with time zone,
  evidence jsonb default '{}'::jsonb not null
);

create table public.fleet_disconnection_checkpoints (
  identity_id uuid not null,
  state jsonb not null,
  updated_at timestamp with time zone not null
);

create table public.fleet_driver_performance_sync (
  source text not null,
  organization_id text not null,
  driver_id uuid not null,
  covered_from timestamp with time zone,
  covered_to timestamp with time zone,
  last_attempt_at timestamp with time zone,
  last_success_at timestamp with time zone,
  status text default 'unconnected'::text not null,
  row_count integer default 0 not null,
  last_error text
);

create table public.fleet_driver_report_summaries (
  source text default 'uber'::text not null,
  organization_id text not null,
  driver_id uuid not null,
  report_type text not null,
  period_from timestamp with time zone not null,
  period_to timestamp with time zone not null,
  reported_at timestamp with time zone default now() not null,
  trips_completed integer,
  online_seconds numeric,
  trip_seconds numeric,
  acceptance_rate numeric,
  cancellation_rate numeric,
  completion_rate numeric,
  accepted_count integer,
  rejected_count integer,
  cancelled_count integer
);

create table public.fleet_drivers (
  id uuid default gen_random_uuid() not null,
  name text not null,
  ludy_driver_code text,
  vehicle_key text,
  agency_id bigint,
  created_at timestamp with time zone default now() not null,
  link_method text,
  link_evidence jsonb default '{}'::jsonb not null,
  vehicle_link_method text,
  vehicle_link_evidence jsonb default '{}'::jsonb not null,
  auto_link_disabled boolean default false not null
);

create table public.fleet_identities (
  id uuid default gen_random_uuid() not null,
  driver_id uuid not null,
  source text not null,
  source_key text not null,
  external_id text,
  organization_id text,
  provisional boolean default false not null
);

create table public.fleet_inventory_sync (
  id integer default 1 not null,
  status text default 'unconnected'::text not null,
  last_attempt_at timestamp with time zone,
  last_success_at timestamp with time zone,
  last_error text,
  counts jsonb default '{}'::jsonb not null
);

create table public.fleet_latest (
  identity_id uuid not null,
  driver_id uuid not null,
  source text not null,
  status text not null,
  observed_at timestamp with time zone not null,
  received_at timestamp with time zone not null,
  source_at timestamp with time zone,
  event_at timestamp with time zone,
  vehicle_label text,
  evidence jsonb default '{}'::jsonb not null,
  offline_since timestamp with time zone,
  offline_samples integer default 0 not null,
  recovery_samples integer default 0 not null
);

create table public.fleet_link_audit (
  id uuid default gen_random_uuid() not null,
  at timestamp with time zone default now() not null,
  driver_id uuid,
  action text not null,
  method text not null,
  evidence jsonb default '{}'::jsonb not null
);

create table public.fleet_motion_alerts (
  id uuid default gen_random_uuid() not null,
  driver_id uuid not null,
  identity_id uuid not null,
  vehicle_key text not null,
  source text not null,
  kind text default 'offline_movement'::text not null,
  severity text default 'critical'::text not null,
  status text default 'open'::text not null,
  observed_since timestamp with time zone not null,
  opened_at timestamp with time zone default now() not null,
  last_seen_at timestamp with time zone default now() not null,
  resolved_at timestamp with time zone,
  distance_m numeric not null,
  threshold_m integer default 200 not null,
  evidence jsonb default '{}'::jsonb not null
);

create table public.fleet_motion_checkpoints (
  identity_id uuid not null,
  vehicle_key text not null,
  source text not null,
  state jsonb not null,
  updated_at timestamp with time zone not null
);

create table public.fleet_myclicar_agencies (
  external_id text not null,
  code text not null,
  name text not null,
  agency_id bigint,
  provider_updated_at timestamp with time zone,
  observed_at timestamp with time zone not null,
  current boolean default true not null
);

create table public.fleet_myclicar_contracts (
  external_id text not null,
  num text not null,
  client_code text,
  name text,
  plate text,
  temporary_plate text,
  model text,
  status text not null,
  start_at timestamp with time zone,
  effective_start_at timestamp with time zone,
  end_at timestamp with time zone,
  provider_updated_at timestamp with time zone,
  deleted boolean default false not null,
  vehicle_key text,
  vehicle_candidates text[] default '{}'::text[] not null,
  current boolean default false not null,
  eligible boolean default false not null,
  reason text default ''::text not null,
  observed_at timestamp with time zone not null,
  agency_id bigint,
  vehicle_external_id text,
  departure_agency_external_id text,
  return_agency_external_id text,
  details_verified boolean default false not null
);

create table public.fleet_myclicar_vehicles (
  external_id text not null,
  reference text not null,
  plate text default ''::text not null,
  temporary_plate text default ''::text not null,
  brand text default ''::text not null,
  model text default ''::text not null,
  vin text default ''::text not null,
  fuel text default ''::text not null,
  status text not null,
  is_blocked boolean default false not null,
  archived boolean default false not null,
  deleted_at timestamp with time zone,
  provider_updated_at timestamp with time zone,
  current boolean default true not null,
  vehicle_key text,
  agency_id bigint,
  reason text default ''::text not null,
  observed_at timestamp with time zone not null
);

create table public.fleet_observations (
  id bigint generated always as identity not null,
  driver_id uuid not null,
  identity_id uuid not null,
  source text not null,
  status text not null,
  observed_at timestamp with time zone not null,
  received_at timestamp with time zone default now() not null,
  source_at timestamp with time zone,
  event_at timestamp with time zone,
  vehicle_label text,
  evidence jsonb default '{}'::jsonb not null
);

create table public.fleet_parking_events (
  event_key text not null,
  vehicle_key text not null,
  zone_id uuid not null,
  kind text not null,
  observed_at timestamp with time zone not null,
  first_observed_at timestamp with time zone not null
);

create table public.fleet_parking_state (
  vehicle_key text not null,
  zone_id uuid not null,
  state jsonb not null,
  updated_at timestamp with time zone default now() not null
);

create table public.fleet_parking_zones (
  id uuid default gen_random_uuid() not null,
  name text not null,
  kind text default 'parking'::text not null,
  agency_id bigint,
  shape jsonb not null,
  enabled boolean default true not null,
  fingerprint text not null,
  source text default 'manual'::text not null,
  source_id text,
  updated_at timestamp with time zone default now() not null,
  revision bigint default 1 not null,
  indicative boolean default false not null,
  archived_at timestamp with time zone,
  archived_by uuid
);

create table public.fleet_provider_vehicles (
  source text not null,
  organization_id text not null,
  external_id text not null,
  plate text,
  make text,
  model text,
  status text,
  received_at timestamp with time zone default now() not null
);

create table public.fleet_rides (
  source text not null,
  organization_id text not null,
  external_id text not null,
  driver_id uuid,
  status text,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  distance_km numeric,
  duration_s numeric,
  amount numeric,
  currency text,
  received_at timestamp with time zone default now() not null,
  requested_at timestamp with time zone,
  accepted_at timestamp with time zone,
  pickup_duration_s numeric,
  passenger_distance_km numeric,
  tip_amount numeric,
  booking_fee numeric,
  toll_fee numeric,
  cancellation_fee numeric,
  stops jsonb default '[]'::jsonb not null,
  provider_driver_id text,
  detail_origin text default 'legacy'::text not null,
  is_optional boolean,
  provider_vehicle_id text,
  vehicle_label text
);

create table public.fleet_rotation_contracts (
  external_id text not null,
  num text not null,
  client_code text,
  plate text,
  temporary_plate text,
  model text,
  status text not null,
  effective_start_at timestamp with time zone,
  end_at timestamp with time zone,
  provider_updated_at timestamp with time zone,
  deleted boolean default false not null,
  vehicle_key text,
  agency_id bigint,
  observed_at timestamp with time zone not null,
  name text default ''::text not null,
  vehicle_external_id text,
  departure_agency_external_id text,
  details_verified boolean default false not null
);

create table public.fleet_rotation_sync (
  id integer default 1 not null,
  status text default 'unconnected'::text not null,
  last_attempt_at timestamp with time zone,
  last_success_at timestamp with time zone,
  last_error text,
  from_at timestamp with time zone,
  to_at timestamp with time zone
);

create table public.fleet_settings (
  id integer not null,
  offline_threshold_s integer default 300 not null,
  schedule jsonb,
  enabled boolean default true not null,
  disconnection_enabled boolean default false not null,
  disconnection_policy text default 'any'::text not null,
  duty_mode text default 'contract'::text not null
);

create table public.fleet_source_events (
  id bigint generated always as identity not null,
  source text not null,
  status text not null,
  at timestamp with time zone default now() not null,
  detail text
);

create table public.fleet_sources (
  id text not null,
  name text not null,
  status text default 'unconnected'::text not null,
  last_success_at timestamp with time zone,
  last_attempt_at timestamp with time zone,
  last_error text,
  stale_after_s integer default 90 not null,
  coverage jsonb default '{}'::jsonb not null,
  metadata jsonb default '{}'::jsonb not null
);

create table public.ops_demand_imports (
  id uuid default gen_random_uuid() not null,
  agency_id bigint not null,
  city text not null,
  file_name text not null,
  fingerprint text not null,
  counts jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);

create table public.ops_demand_rides (
  agency_id bigint not null,
  ride_key text not null,
  import_id uuid not null,
  city text not null,
  external_id text,
  started_at timestamp with time zone not null,
  pickup_zone text not null,
  status text not null
);

create table public.ops_event_reviews (
  id bigint generated always as identity not null,
  event_id uuid not null,
  decision text not null,
  fingerprint text not null,
  reviewed_by uuid not null,
  reviewed_at timestamp with time zone default now() not null
);

create table public.ops_event_sources (
  id text not null,
  name text not null,
  url text not null,
  enabled boolean default true not null,
  status text default 'pending'::text not null,
  last_attempt_at timestamp with time zone,
  last_success_at timestamp with time zone,
  last_error text,
  received_count integer default 0 not null
);

create table public.ops_events (
  id uuid default gen_random_uuid() not null,
  source_id text not null,
  external_key text not null,
  source_url text not null,
  city text not null,
  title text not null,
  place text default ''::text not null,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  source_date_text text default ''::text not null,
  time_precision text default 'unknown'::text not null,
  fingerprint text not null,
  status text default 'pending'::text not null,
  observed_at timestamp with time zone not null,
  reviewed_at timestamp with time zone,
  reviewed_by uuid
);

create table public.ops_fuel_checkpoints (
  vehicle_key text not null,
  state jsonb not null,
  updated_at timestamp with time zone default now() not null
);

create table public.ops_fuel_reference_runs (
  id integer not null,
  status text default 'pending'::text not null,
  last_attempt_at timestamp with time zone,
  last_success_at timestamp with time zone,
  next_attempt_at timestamp with time zone,
  last_error text,
  candidates integer default 0 not null,
  applied integer default 0 not null,
  insufficient integer default 0 not null
);

create table public.ops_fuel_settings (
  id integer not null,
  enabled boolean default true not null,
  excess_pct numeric default 30 not null,
  min_distance_km numeric default 10 not null,
  cooldown_minutes integer default 60 not null
);

create table public.ops_rush_rules (
  id uuid default gen_random_uuid() not null,
  agency_id bigint not null,
  city text not null,
  days jsonb not null,
  start text not null,
  "end" text not null,
  label text default ''::text not null,
  enabled boolean default true not null,
  created_at timestamp with time zone default now() not null
);

create table public.provider_earnings_rows (
  snapshot_id uuid not null,
  provider_row integer not null,
  source text not null,
  organization_id uuid not null,
  period_start timestamp with time zone not null,
  period_end timestamp with time zone not null,
  time_zone text not null,
  currency text not null,
  observed_at timestamp with time zone not null,
  snapshot_revision bigint not null,
  coverage_complete boolean not null,
  mapping_complete boolean not null,
  agency_rows_total integer not null,
  driver_rows_total integer not null,
  provider_driver_id uuid,
  driver_name text not null,
  driver_name_complete boolean not null,
  fleet_driver_id uuid,
  driver_code text,
  agency_id bigint,
  mapping_status text not null,
  amounts jsonb not null,
  financial_provenance jsonb
);

create table public.provider_earnings_snapshots (
  id uuid default gen_random_uuid() not null,
  source text default 'uber'::text not null,
  organization_id uuid not null,
  period_start timestamp with time zone not null,
  period_end timestamp with time zone not null,
  time_zone text not null,
  period_label text not null,
  period_mode text not null,
  currency text not null,
  observed_at timestamp with time zone not null,
  received_at timestamp with time zone default now() not null,
  revision bigint default 1 not null,
  sha256 text not null,
  content_fingerprint text not null,
  mapping_fingerprint text not null,
  coverage jsonb not null,
  mapping_complete boolean not null,
  fleet_amounts jsonb not null,
  source_url text not null,
  financial_provenance jsonb
);

create table public.revenue_refresh (
  agency_id bigint not null,
  version bigint default 1 not null,
  touched_at timestamp with time zone default now() not null
);

create table public.telemetry_observations (
  id uuid default gen_random_uuid() not null,
  source text not null,
  source_event_id text not null,
  device_id text not null,
  vehicle_key text not null,
  observed_at timestamp with time zone not null,
  collected_at timestamp with time zone not null,
  received_at timestamp with time zone default clock_timestamp() not null,
  version integer not null,
  fingerprint text not null,
  observation jsonb not null,
  origin jsonb not null,
  agency_id_at_receipt bigint,
  mapping_basis text not null
);

create table public.uber_driver_report_imports (
  organization_id uuid not null,
  config_revision bigint not null,
  report_type text not null,
  file_sha256 text not null,
  period_from timestamp with time zone not null,
  period_to timestamp with time zone not null,
  counts jsonb not null,
  created_at timestamp with time zone default now() not null,
  last_received_at timestamp with time zone default now() not null
);

create table public.uber_report_import_log (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  config_revision bigint not null,
  file_sha256 text not null,
  counts jsonb not null,
  results jsonb not null,
  created_at timestamp with time zone default now() not null
);

create table public.uber_report_settings (
  id integer not null,
  enabled boolean default false not null,
  organization_id uuid,
  city_agencies jsonb default '{}'::jsonb not null,
  date_format text default 'ymd'::text not null,
  revision bigint default 1 not null,
  updated_at timestamp with time zone default now() not null,
  last_attempt_at timestamp with time zone,
  last_success_at timestamp with time zone,
  last_status text default 'unconfigured'::text not null,
  last_error text,
  last_counts jsonb default '{}'::jsonb not null,
  collector_seen_at timestamp with time zone,
  collector_state jsonb default '{}'::jsonb not null,
  organization_label text,
  csv_timezone text
);

-- ----------------------------------------------------------------------------- Fonctions

CREATE OR REPLACE FUNCTION public.desktop_admin_request(p_device_id uuid, p_resource text, p_method text, p_params jsonb DEFAULT '{}'::jsonb, p_body jsonb DEFAULT NULL::jsonb, p_prefer text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 actor uuid;expected text[];cols text[];allowed text[];fields text[];chosen text[];conditions text[]:='{}';
 k text;v text;part text;item record;bits text[];where_sql text:='true';order_sql text:='';select_sql text;field_sql text;set_sql text;
 conflict_sql text:='';resolution text;return_rows boolean:=false;count_exact boolean:=false;limit_n integer:=1000;offset_n integer:=0;total bigint;
 result jsonb;headers jsonb:='{}';reference public.drivers;body jsonb:=p_body;mapping_lease public.desktop_worker_leases;
begin
 perform desktop_worker_private.device(p_device_id,false);actor:=auth.uid();
 if p_method is null or p_method not in('GET','POST','PATCH') or p_resource is null or length(p_resource)>100
  or jsonb_typeof(p_params) is distinct from 'object' or pg_column_size(p_params)>131072 or pg_column_size(p_body)>8388608 then
  raise exception using errcode='22023',message='Invalid desktop administrator request';end if;
 if p_prefer is not null then
  if length(p_prefer)>200 then raise exception using errcode='22023',message='Invalid administrator preference';end if;
  foreach part in array string_to_array(p_prefer,',') loop
   part:=btrim(part);
   if part='return=representation' then return_rows:=true;
   elsif part='return=minimal' then null;
   elsif part='count=exact' then count_exact:=true;
   elsif part in('resolution=merge-duplicates','resolution=ignore-duplicates') and resolution is null then resolution:=part;
   else raise exception using errcode='22023',message='Unsupported administrator preference';end if;
  end loop;
 end if;
 if left(p_resource,4)='rpc/' then
  if p_method<>'POST' or p_params<>'{}'::jsonb or p_prefer is not null then raise exception using errcode='22023',message='Unsupported administrator RPC options';end if;
  expected:=case p_resource
   when 'rpc/uber_report_configure' then array['p_enabled','p_org','p_mapping','p_format','p_user','p_org_label','p_csv_timezone']
   when 'rpc/fleet_link_driver' then array['p_driver','p_ludy_code','p_vehicle_key','p_agency_id']
   when 'rpc/fleet_link_driver_automatic' then array['p_driver','p_ludy_code','p_agency_id']
   when 'rpc/fleet_archive_parking_zone' then array['p_id','p_revision','p_user']
   when 'rpc/ops_mutate_manual_event' then array['p_action','p_id','p_expected','p_row','p_user']
   when 'rpc/driver_portal_rotate' then array['p_account','p_credential_hash','p_user']
   when 'rpc/ops_import_demand' then array['p_import','p_rows']
   else null end;
  if expected is null or jsonb_typeof(body) is distinct from 'object' or not(body ?& expected)
   or exists(select 1 from jsonb_object_keys(body) x where not(x=any(expected))) then
   raise exception using errcode='22023',message='Unsupported administrator RPC arguments';end if;
  if 'p_user'=any(expected) and (body->>'p_user')::uuid is distinct from actor then
   raise exception using errcode='42501',message='Administrator actor must match the authenticated session';end if;
  case p_resource
   when 'rpc/uber_report_configure' then select public.uber_report_configure((body->>'p_enabled')::boolean,(body->>'p_org')::uuid,body->'p_mapping',body->>'p_format',actor,body->>'p_org_label',body->>'p_csv_timezone') into result;
   when 'rpc/fleet_link_driver' then select to_jsonb(public.fleet_link_driver((body->>'p_driver')::uuid,body->>'p_ludy_code',body->>'p_vehicle_key',(body->>'p_agency_id')::bigint)) into result;
   when 'rpc/fleet_link_driver_automatic' then select to_jsonb(public.fleet_link_driver_automatic((body->>'p_driver')::uuid,body->>'p_ludy_code',(body->>'p_agency_id')::bigint)) into result;
   when 'rpc/fleet_archive_parking_zone' then select public.fleet_archive_parking_zone((body->>'p_id')::uuid,(body->>'p_revision')::bigint,actor) into result;
   when 'rpc/ops_mutate_manual_event' then select public.ops_mutate_manual_event(body->>'p_action',(body->>'p_id')::uuid,body->>'p_expected',body->'p_row',actor) into result;
   when 'rpc/driver_portal_rotate' then select public.driver_portal_rotate((body->>'p_account')::uuid,body->>'p_credential_hash',actor) into result;
   when 'rpc/ops_import_demand' then select public.ops_import_demand(body->'p_import',body->'p_rows') into result;
  end case;
  return jsonb_build_object('status',200,'body',coalesce(result,'null'::jsonb),'headers',headers);
 end if;
 cols:=desktop_worker_private.admin_columns(p_resource);chosen:=cols;
 if cols is null then raise exception using errcode='22023',message='Unsupported administrator resource';end if;
 if p_method<>'GET' then
  allowed:=case p_resource||':'||p_method
   when 'fleet_settings:PATCH' then array['offline_threshold_s','schedule','enabled','disconnection_enabled','disconnection_policy','duty_mode']
   when 'ops_fuel_settings:PATCH' then array['enabled','excess_pct','min_distance_km','cooldown_minutes']
   when 'vehicles:PATCH' then array['ref_l100','fuel_reference_evidence','geotab_id','geotab_name','geotab_auto_link_disabled']
   when 'ops_rush_rules:POST' then array['agency_id','city','days','start','end','enabled','label']
   when 'ops_rush_rules:PATCH' then array['agency_id','city','days','start','end','enabled','label']
   when 'fleet_parking_zones:POST' then array['id','name','agency_id','kind','shape','enabled','indicative','fingerprint','updated_at','source','source_id','archived_at','archived_by']
   when 'fleet_parking_zones:PATCH' then array['name','agency_id','kind','shape','enabled','indicative','fingerprint','updated_at']
   when 'driver_portal_accounts:POST' then array['ludy_driver_code','agency_id','display_name','credential_hash','active','created_at','rotated_at']
   when 'driver_reports:PATCH' then array['status','admin_note','reviewed_at','reviewed_by']
   else null end;
  if allowed is null or jsonb_typeof(body) is distinct from 'object' or body='{}'::jsonb then raise exception using errcode='22023',message='Unsupported administrator mutation';end if;
  select array_agg(x order by x) into fields from jsonb_object_keys(body) x;
  if not(fields<@allowed) then raise exception using errcode='22023',message='Unsupported administrator write column';end if;
 end if;
 for item in select e.key,e.value from jsonb_each(p_params) e order by e.key loop
  if jsonb_typeof(item.value) is distinct from 'string' then raise exception using errcode='22023',message='Administrator query options must be strings';end if;
  k:=item.key;v:=item.value#>>'{}';
  if k='select' then
   if v<>'*' then chosen:=string_to_array(v,',');if cardinality(chosen)=0 or not(chosen<@cols) then raise exception using errcode='22023',message='Unsupported administrator selection';end if;end if;
  elsif k='limit' then
   if p_method<>'GET' or v !~ '^[0-9]{1,4}$' or v::integer not between 1 and 2000 then raise exception using errcode='22023',message='Invalid administrator read limit';end if;limit_n:=v::integer;
  elsif k='offset' then
   if p_method<>'GET' or v !~ '^[0-9]{1,6}$' or v::integer not between 0 and 100000 then raise exception using errcode='22023',message='Invalid administrator read offset';end if;offset_n:=v::integer;
  elsif k='order' then
   if p_method<>'GET' then raise exception using errcode='22023',message='Unsupported administrator write order';end if;
   foreach part in array string_to_array(v,',') loop
    bits:=string_to_array(part,'.');
    if not(bits[1]=any(cols)) or cardinality(bits)>3 or cardinality(bits)>1 and bits[2] not in('asc','desc') or cardinality(bits)>2 and bits[3] not in('nullsfirst','nullslast') then
     raise exception using errcode='22023',message='Unsupported administrator order';end if;
    order_sql:=order_sql||case when order_sql='' then '' else ',' end||format('t.%I',bits[1])||' '||coalesce(bits[2],'asc')||case bits[3] when 'nullsfirst' then ' nulls first' when 'nullslast' then ' nulls last' else '' end;
   end loop;
  elsif k='on_conflict' then
   if p_resource<>'fleet_parking_zones' or p_method<>'POST' or v not in('id','source,source_id') then raise exception using errcode='22023',message='Unsupported administrator conflict key';end if;
  elsif k='and' then
   if left(v,1)<>'(' or right(v,1)<>')' or length(v)>4096 then raise exception using errcode='22023',message='Invalid administrator bounds';end if;
   foreach part in array string_to_array(substring(v from 2 for length(v)-2),',') loop
    k:=split_part(part,'.',1);conditions:=array_append(conditions,desktop_worker_private.predicate(k,substring(part from length(k)+2),cols));
   end loop;
  else conditions:=array_append(conditions,desktop_worker_private.predicate(k,v,cols));end if;
 end loop;
 if p_resource='params' then conditions:=array_append(conditions,'t.key in (''environment'',''shiftDay'',''shiftNight'',''shiftAdvance'',''tzRules'')');end if;
 if cardinality(conditions)>0 then where_sql:=array_to_string(conditions,' and ');end if;
 select string_agg(format('t.%I',x),',') into select_sql from unnest(chosen) x;
 if p_method='GET' then
  if p_body is not null and p_body<>'null'::jsonb or resolution is not null then raise exception using errcode='22023',message='Invalid administrator read body';end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb) from (select %s from public.%I t where %s%s limit %s offset %s) q',select_sql,p_resource,where_sql,case when order_sql='' then '' else ' order by '||order_sql end,limit_n,offset_n) into result;
  if count_exact then execute format('select count(*) from public.%I t where %s',p_resource,where_sql) into total;headers:=jsonb_build_object('content-range',case when jsonb_array_length(result)=0 then '*' else offset_n||'-'||(offset_n+jsonb_array_length(result)-1) end||'/'||total);end if;
 else
  if p_resource='driver_portal_accounts' then
   if not(body ?& array['ludy_driver_code','agency_id','display_name','credential_hash','active']) or body->'active' is distinct from 'true'::jsonb or coalesce(body->>'credential_hash','') !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='Invalid driver account provisioning';end if;
   select * into reference from public.drivers where code=body->>'ludy_driver_code' for share;
   if not found or reference.agency_id is distinct from (body->>'agency_id')::bigint or btrim(reference.name) is distinct from body->>'display_name' then raise exception using errcode='22023',message='Driver account must match the confirmed reference';end if;
   body:=body||jsonb_build_object('created_at',clock_timestamp(),'rotated_at',clock_timestamp());
  elsif p_resource='driver_reports' then
   if not(body ?& array['status','admin_note','reviewed_at','reviewed_by']) or (body->>'reviewed_by')::uuid is distinct from actor then raise exception using errcode='42501',message='Moderator must match the authenticated administrator';end if;
   body:=body||jsonb_build_object('reviewed_at',clock_timestamp());
  elsif p_resource='vehicles' then
   if body ?| array['geotab_id','geotab_name','geotab_auto_link_disabled'] then
    if not(fields<@array['geotab_id','geotab_name','geotab_auto_link_disabled']) or body->'geotab_auto_link_disabled' is distinct from 'true'::jsonb
     or (body ? 'geotab_id' and body->>'geotab_id' is not null and (jsonb_typeof(body->'geotab_id')<>'string' or length(body->>'geotab_id') not between 1 and 200))
     or (body ? 'geotab_name' and body->>'geotab_name' is not null and (jsonb_typeof(body->'geotab_name')<>'string' or length(body->>'geotab_name')>200)) then
     raise exception using errcode='22023',message='Invalid manual Geotab association';end if;
    -- The surrounding provider action also deletes old live state and pauses
    -- collection. Require this PC to own the workspace before its first effect.
    perform desktop_worker_private.device(p_device_id,true);
    select * into strict mapping_lease from public.desktop_worker_leases where scope='workspace' for share;
    if mapping_lease.device_id is distinct from p_device_id or mapping_lease.expires_at<=clock_timestamp() then
     raise exception using errcode='55000',message='Desktop lease required for provider association';end if;
   else
   if not(body ?& array['ref_l100','fuel_reference_evidence']) or jsonb_typeof(body->'ref_l100') is distinct from 'number' or (body->>'ref_l100')::numeric not between 0.01 and 100
    or body->'fuel_reference_evidence'->>'method' is distinct from 'manual' or body->'fuel_reference_evidence'->'value' is distinct from body->'ref_l100'
    or exists(select 1 from jsonb_object_keys(body->'fuel_reference_evidence') x where x not in('method','value','calculated_at')) then raise exception using errcode='22023',message='Invalid manual fuel reference';end if;
   body:=jsonb_set(body,'{fuel_reference_evidence,calculated_at}',to_jsonb(clock_timestamp()));
   end if;
  elsif p_resource='ops_rush_rules' then
   if not(body ?& array['agency_id','city','days','start','end','enabled','label']) or not exists(select 1 from public.agencies a where a.id=(body->>'agency_id')::bigint and lower(btrim(a.city))=lower(body->>'city')) then raise exception using errcode='22023',message='Rush rule agency and city must match';end if;
  end if;
  select array_agg(x order by x) into fields from jsonb_object_keys(body) x;
  if p_method='PATCH' then
   if resolution is not null or p_params ? 'on_conflict' then raise exception using errcode='22023',message='Unsupported administrator patch preference';end if;
   if p_resource='vehicles' then
    if coalesce(p_params->>'key','') !~ '^eq\.' then raise exception using errcode='22023',message='Manual fuel reference needs exact vehicle';end if;
   elsif p_resource in('fleet_settings','ops_fuel_settings') then
    if p_params->>'id' is distinct from 'eq.1' then raise exception using errcode='22023',message='Administrator singleton selector required';end if;
   elsif coalesce(p_params->>'id','') !~ '^eq\.' then raise exception using errcode='22023',message='Administrator row selector required';end if;
   if p_resource='fleet_parking_zones' and (coalesce(p_params->>'revision','') !~ '^eq\.[1-9][0-9]*$' or p_params->>'archived_at' is distinct from 'is.null') then raise exception using errcode='22023',message='Parking revision guard required';end if;
   select string_agg(format('%1$I=patch.%1$I',x),',') into set_sql from unnest(fields) x;
   execute format('with changed as(update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) patch where %3$s returning t.*) select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb) from(select %4$s from changed t)q',p_resource,set_sql,where_sql,select_sql) into result using body;
  else
   if cardinality(conditions)>0 then raise exception using errcode='22023',message='Administrator insert cannot have filters';end if;
   if p_resource='fleet_parking_zones' then
    if body->>'source'='manual' then
     if p_params->>'on_conflict' is distinct from 'id' or resolution is distinct from 'resolution=ignore-duplicates' or not(body ? 'id') or (body->>'id')::uuid is null or body->>'source_id' is not null or body ?| array['archived_at','archived_by'] then raise exception using errcode='22023',message='Invalid manual parking creation';end if;
     conflict_sql:=' on conflict(id) do nothing';
    elsif body->>'source'='geotab' then
     if p_params->>'on_conflict' is distinct from 'source,source_id' or resolution is distinct from 'resolution=merge-duplicates' or body ? 'id' or coalesce(body->>'source_id','')='' or body->>'archived_at' is not null or body->>'archived_by' is not null then raise exception using errcode='22023',message='Invalid provider parking import';end if;
     select string_agg(format('%1$I=excluded.%1$I',x),',') into set_sql from unnest(fields) x where x not in('source','source_id');
     conflict_sql:=' on conflict(source,source_id) do update set '||set_sql;
    else raise exception using errcode='22023',message='Explicit parking source required';end if;
   elsif resolution is not null or p_params ? 'on_conflict' then raise exception using errcode='22023',message='Unsupported administrator insert conflict';end if;
   select string_agg(format('%I',x),',') into field_sql from unnest(fields) x;
   execute format('with changed as(insert into public.%1$I(%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1)%3$s returning *) select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb) from(select %4$s from changed t)q',p_resource,field_sql,conflict_sql,select_sql) into result using body;
  end if;
  if not return_rows then result:='null'::jsonb;end if;
 end if;
 if mapping_lease.expires_at is not null and mapping_lease.expires_at<=clock_timestamp() then
  raise exception using errcode='55000',message='Desktop lease expired during provider association';end if;
 return jsonb_build_object('status',case when p_method='GET' then 200 when p_method='POST' then 201 when return_rows then 200 else 204 end,'body',coalesce(result,'null'::jsonb),'headers',headers);
end $function$;

CREATE OR REPLACE FUNCTION public.desktop_manager_request(p_resource text, p_method text, p_params jsonb DEFAULT '{}'::jsonb, p_body jsonb DEFAULT NULL::jsonb, p_prefer text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 actor uuid:=auth.uid();staff_role text;scopes bigint[];target_agency bigint;target_city text;old_rule public.ops_rush_rules;stored public.ops_rush_rules;
 rule_id uuid;result jsonb;return_rows boolean:=false;expected text[];entry jsonb;import_meta jsonb;rows jsonb;
begin
 if actor is null or auth.role() is distinct from 'authenticated' then raise exception using errcode='42501',message='Staff session required';end if;
 select p.role into staff_role from public.profiles p where p.user_id=actor for share;
 if coalesce(staff_role,'') not in('admin','manager') then raise exception using errcode='42501',message='Agency editor required';end if;
 if staff_role='admin' and public.is_admin() is distinct from true then raise exception using errcode='42501',message='Administrator verification failed';end if;
 -- A membership deletion/reassignment cannot race an authorized write.
 perform 1 from public.user_agencies a where a.user_id=actor order by a.agency_id for share;
 scopes:=public.my_agency_ids();
 if p_resource is null or p_method is null or jsonb_typeof(p_params) is distinct from 'object' or pg_column_size(p_params)>4096
  or jsonb_typeof(p_body) is distinct from 'object' or pg_column_size(p_body)>8388608 then raise exception using errcode='22023',message='Invalid agency edit request';end if;
 if p_prefer is not null and p_prefer not in('return=representation','return=minimal') then raise exception using errcode='22023',message='Unsupported agency edit preference';end if;
 return_rows:=p_prefer='return=representation';
 if p_resource='ops_rush_rules' and p_method in('POST','PATCH') then
  expected:=array['agency_id','city','days','start','end','enabled','label'];
  if not(p_body ?& expected) or exists(select 1 from jsonb_object_keys(p_body) k where not(k=any(expected)))
   or jsonb_typeof(p_body->'agency_id') is distinct from 'number' or coalesce(p_body->>'agency_id','') !~ '^[1-9][0-9]{0,15}$'
   or coalesce(p_body->>'city','') not in('Casablanca','Marrakech') or jsonb_typeof(p_body->'enabled') is distinct from 'boolean'
   or jsonb_typeof(p_body->'days') is distinct from 'array' or jsonb_array_length(p_body->'days') not between 1 and 7
   or exists(select 1 from jsonb_array_elements(p_body->'days') d where jsonb_typeof(d)<>'number' or d::text !~ '^[1-7]$')
   or (select count(distinct d) from jsonb_array_elements(p_body->'days') d)<>jsonb_array_length(p_body->'days')
   or coalesce(p_body->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(p_body->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
   or p_body->>'start'=p_body->>'end' or jsonb_typeof(p_body->'label') is distinct from 'string' or length(p_body->>'label')>100 then
   raise exception using errcode='22023',message='Invalid agency rush rule';end if;
  target_agency:=(p_body->>'agency_id')::bigint;target_city:=p_body->>'city';
  if staff_role='manager' and coalesce(target_agency=any(scopes),false) is distinct from true then raise exception using errcode='42501',message='Agency edit unavailable';end if;
  if p_method='PATCH' then
   if not(p_params ? 'id') or exists(select 1 from jsonb_object_keys(p_params) k where k<>'id') or coalesce(p_params->>'id','') !~ '^eq\.[0-9a-fA-F-]{36}$' then
    raise exception using errcode='22023',message='Exact rush rule selector required';end if;
   rule_id:=substring(p_params->>'id' from 4)::uuid;
   select * into old_rule from public.ops_rush_rules where id=rule_id for update;
   if not found or (staff_role='manager' and coalesce(old_rule.agency_id=any(scopes),false) is distinct from true) then
    raise exception using errcode='42501',message='Agency edit unavailable';end if;
  elsif p_params<>'{}'::jsonb then raise exception using errcode='22023',message='Rush creation has no query selectors';end if;
  perform 1 from public.agencies a where a.id=target_agency and lower(btrim(a.city))=lower(target_city) for share;
  if not found then raise exception using errcode='22023',message='Rush agency and city must match';end if;
  if p_method='POST' then
   insert into public.ops_rush_rules(agency_id,city,days,start,"end",enabled,label)
    values(target_agency,target_city,p_body->'days',p_body->>'start',p_body->>'end',(p_body->>'enabled')::boolean,p_body->>'label') returning * into stored;
  else
   update public.ops_rush_rules set agency_id=target_agency,city=target_city,days=p_body->'days',start=p_body->>'start',"end"=p_body->>'end',enabled=(p_body->>'enabled')::boolean,label=p_body->>'label'
    where id=rule_id returning * into stored;
  end if;
  result:=case when return_rows then jsonb_build_array(jsonb_build_object('id',stored.id,'agency_id',stored.agency_id,'city',stored.city,'days',stored.days,'start',stored.start,'end',stored."end",'enabled',stored.enabled,'label',stored.label,'created_at',stored.created_at)) else 'null'::jsonb end;
  return jsonb_build_object('status',case when p_method='POST' then 201 when return_rows then 200 else 204 end,'body',result,'headers','{}'::jsonb);
 elsif p_resource='rpc/ops_import_demand' and p_method='POST' then
  if p_params<>'{}'::jsonb or p_prefer is not null or not(p_body ?& array['p_import','p_rows']) or exists(select 1 from jsonb_object_keys(p_body) k where k not in('p_import','p_rows')) then
   raise exception using errcode='22023',message='Invalid agency import arguments';end if;
  import_meta:=p_body->'p_import';rows:=p_body->'p_rows';
  if jsonb_typeof(import_meta) is distinct from 'object' or not(import_meta ?& array['agency_id','city','file_name','fingerprint','counts'])
   or exists(select 1 from jsonb_object_keys(import_meta) k where k not in('agency_id','city','file_name','fingerprint','counts','rows'))
   or jsonb_typeof(import_meta->'agency_id') is distinct from 'number' or coalesce(import_meta->>'agency_id','') !~ '^[1-9][0-9]{0,15}$'
   or coalesce(import_meta->>'city','') not in('Casablanca','Marrakech') or jsonb_typeof(import_meta->'file_name') is distinct from 'string' or length(import_meta->>'file_name') not between 1 and 200
   or coalesce(import_meta->>'fingerprint','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(import_meta->'counts') is distinct from 'object'
   or jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows) not between 1 and 20000
   or (import_meta ? 'rows' and import_meta->'rows' is distinct from rows) then raise exception using errcode='22023',message='Invalid normalized agency import';end if;
  target_agency:=(import_meta->>'agency_id')::bigint;target_city:=import_meta->>'city';
  if staff_role='manager' and coalesce(target_agency=any(scopes),false) is distinct from true then raise exception using errcode='42501',message='Agency import unavailable';end if;
  perform 1 from public.agencies a where a.id=target_agency and lower(btrim(a.city))=lower(target_city) for share;
  if not found then raise exception using errcode='22023',message='Import agency and city must match';end if;
  for entry in select * from jsonb_array_elements(rows) loop
   if jsonb_typeof(entry) is distinct from 'object' or not(entry ?& array['ride_key','external_id','started_at','pickup_zone','status'])
    or exists(select 1 from jsonb_object_keys(entry) k where k not in('ride_key','external_id','started_at','pickup_zone','status'))
    or coalesce(entry->>'ride_key','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(entry->'external_id') is distinct from 'string' or length(entry->>'external_id') not between 1 and 200
    or jsonb_typeof(entry->'pickup_zone') is distinct from 'string' or length(btrim(entry->>'pickup_zone')) not between 1 and 200
    or coalesce(entry->>'status','') not in('completed','cancelled') or coalesce(entry->>'started_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$'
    or not isfinite((entry->>'started_at')::timestamptz) or (entry->>'started_at')::timestamptz<'2000-01-01Z'::timestamptz or (entry->>'started_at')::timestamptz>clock_timestamp()+interval '5 minutes' then
    raise exception using errcode='22023',message='Invalid normalized demand row';end if;
  end loop;
  if (select count(distinct r->>'ride_key') from jsonb_array_elements(rows) r)<>jsonb_array_length(rows) then raise exception using errcode='22023',message='Duplicate normalized demand keys';end if;
  -- The existing RPC assigns EVERY row to agency from p_import. Client rows have
  -- no agency column, and the underlying conflict key includes agency_id.
  result:=public.ops_import_demand(import_meta,rows);
  return jsonb_build_object('status',200,'body',result,'headers','{}'::jsonb);
 end if;
 raise exception using errcode='22023',message='Unsupported agency operation';
end $function$;

CREATE OR REPLACE FUNCTION public.desktop_vehicle_live_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 -- The server timestamps receipt. A delayed older refresh cannot replace a
 -- newer snapshot from this device. The binding is checked on every UI read.
 if tg_op='UPDATE' and old.data->>'device_id'=new.data->>'device_id'
    and (old.data->>'captured_at')::timestamptz>(new.data->>'captured_at')::timestamptz then return null;end if;
 new.observed_at:=clock_timestamp();return new;
end $function$;

CREATE OR REPLACE FUNCTION public.desktop_worker_claim(p_device_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare lease public.desktop_worker_leases;at timestamptz;
begin
 perform desktop_worker_private.device(p_device_id,true);
 select * into strict lease from public.desktop_worker_leases where scope='workspace' for update;
 at:=clock_timestamp();
 if lease.device_id is not null and lease.device_id<>p_device_id and lease.expires_at>at then
  return desktop_worker_private.state(p_device_id);end if;
 update public.desktop_worker_leases set device_id=p_device_id,
  fence=case when lease.device_id=p_device_id and lease.expires_at>at then fence else fence+1 end,
  expires_at=at+interval '90 seconds',updated_at=at where scope='workspace';
 return desktop_worker_private.state(p_device_id);
end $function$;

CREATE OR REPLACE FUNCTION public.desktop_worker_register(p_device_id uuid, p_label text, p_enabled boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare uid uuid:=desktop_worker_private.admin_user();d public.desktop_worker_devices;
begin
 if p_device_id is null or p_enabled is null or char_length(btrim(p_label)) not between 1 and 120 or p_label is null or p_label ~ '[[:cntrl:]]' then
  raise exception using errcode='22023',message='Invalid desktop device';end if;
 insert into public.desktop_worker_devices(id,owner_id,label,enabled,approved_at)
 values(p_device_id,uid,btrim(p_label),p_enabled,case when p_enabled then clock_timestamp() end) on conflict(id) do nothing;
 select * into d from public.desktop_worker_devices where id=p_device_id for update;
 if d.owner_id<>uid then raise exception using errcode='42501',message='Desktop device unavailable';end if;
 update public.desktop_worker_devices set label=btrim(p_label),enabled=p_enabled,updated_at=clock_timestamp(),
  approved_at=case when p_enabled then coalesce(approved_at,clock_timestamp()) else null end where id=p_device_id;
 -- Disabling does not reset the sequence. Re-enabling requires a fresh claim.
 if not p_enabled then update public.desktop_worker_leases set device_id=null,expires_at='-infinity',updated_at=clock_timestamp()
  where scope='workspace' and device_id=p_device_id;end if;
 return desktop_worker_private.state(p_device_id);
end $function$;

CREATE OR REPLACE FUNCTION public.desktop_worker_release(p_device_id uuid, p_fence bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare lease public.desktop_worker_leases;
begin
 perform desktop_worker_private.device(p_device_id,false);
 select * into strict lease from public.desktop_worker_leases where scope='workspace' for update;
 if p_fence is null or lease.device_id is distinct from p_device_id or lease.fence<>p_fence then
  raise exception using errcode='55000',message='Desktop lease lost';end if;
 update public.desktop_worker_leases set device_id=null,expires_at='-infinity',updated_at=clock_timestamp() where scope='workspace';
 return jsonb_build_object('version',1,'released',true);
end $function$;

CREATE OR REPLACE FUNCTION public.desktop_worker_renew(p_device_id uuid, p_fence bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare lease public.desktop_worker_leases;at timestamptz;
begin
 perform desktop_worker_private.device(p_device_id,true);
 select * into strict lease from public.desktop_worker_leases where scope='workspace' for update;
 at:=clock_timestamp();
 if p_fence is null or lease.device_id is distinct from p_device_id or lease.fence<>p_fence or lease.expires_at<=at then
  raise exception using errcode='55000',message='Desktop lease lost';end if;
 update public.desktop_worker_leases set expires_at=at+interval '90 seconds',updated_at=at where scope='workspace';
 return desktop_worker_private.state(p_device_id);
end $function$;

CREATE OR REPLACE FUNCTION public.desktop_worker_request(p_device_id uuid, p_fence bigint, p_resource text, p_method text, p_params jsonb DEFAULT '{}'::jsonb, p_body jsonb DEFAULT NULL::jsonb, p_prefer text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 cols text[];allowed text[];fields text[];chosen text[];column_name text;item record;value jsonb;part text;bits text[];
 conditions text[]:='{}';where_sql text:='true';order_sql text:='';select_sql text;sql text;sets text;conflict text;conflict_sql text:='';
 limit_n integer:=1000;offset_n integer:=0;total bigint;affected bigint;results jsonb:='[]';result jsonb;row_body jsonb;rows jsonb;
 lease public.desktop_worker_leases;prefer text[];return_rows boolean:=false;count_exact boolean:=false;resolution text;
 begin_at timestamptz;headers jsonb:='{}';wrote boolean;
begin
 if p_method is null or p_method not in ('GET','POST','PATCH','DELETE') or p_resource is null or char_length(p_resource)>100
  or jsonb_typeof(p_params) is distinct from 'object' or pg_column_size(p_params)>131072 or pg_column_size(p_body)>8388608 then
  raise exception using errcode='22023',message='Invalid desktop request';end if;
 wrote:=p_method<>'GET';
 perform desktop_worker_private.device(p_device_id,wrote);
 if wrote then
  -- Held until the business transaction commits, so takeover/release/revocation
  -- waits for an in-flight write; no stale writer can cross a newer generation.
  select * into strict lease from public.desktop_worker_leases where scope='workspace' for share;
  begin_at:=clock_timestamp();
  if p_fence is null or lease.device_id is distinct from p_device_id or lease.fence<>p_fence or lease.expires_at<=begin_at then
   raise exception using errcode='55000',message='Desktop lease lost';end if;
 end if;
 if p_prefer is not null then
  if length(p_prefer)>200 then raise exception using errcode='22023',message='Unsupported desktop preference';end if;
  prefer:=string_to_array(p_prefer,',');
  foreach part in array prefer loop
   part:=btrim(part);
   if part='return=representation' then return_rows:=true;
   elsif part='return=minimal' then null;
   elsif part='count=exact' then count_exact:=true;
   elsif part in ('resolution=merge-duplicates','resolution=ignore-duplicates') and resolution is null then resolution:=part;
   else raise exception using errcode='22023',message='Unsupported desktop preference';end if;
  end loop;
 end if;
 if left(p_resource,4)='rpc/' then
  if p_method<>'POST' or p_params<>'{}'::jsonb or p_prefer is not null then
   raise exception using errcode='22023',message='Unsupported desktop RPC request';end if;
  result:=desktop_worker_private.rpc(p_resource,p_body);
 else
  cols:=desktop_worker_private.read_columns(p_resource);
  allowed:=desktop_worker_private.write_columns(p_resource,p_method);
  if cols is null or (wrote and allowed is null) then raise exception using errcode='22023',message='Unsupported desktop resource operation';end if;
  chosen:=cols;
  for item in select q.key,q.value from jsonb_each(p_params) q order by q.key loop
   if item.key in ('select','order','limit','offset','on_conflict') then
    if jsonb_typeof(item.value)<>'string' then raise exception using errcode='22023',message='Invalid desktop query option';end if;
    part:=item.value#>>'{}';
    case item.key
     when 'select' then
      if part<>'*' then
       chosen:=string_to_array(part,',');
       if cardinality(chosen)=0 or exists(select 1 from unnest(chosen) c where not(c=any(cols))) then
        raise exception using errcode='22023',message='Unsupported desktop selection';end if;
      end if;
     when 'order' then
      if wrote then raise exception using errcode='22023',message='Unsupported desktop write order';end if;
      foreach column_name in array string_to_array(part,',') loop
       bits:=string_to_array(column_name,'.');
       if not(bits[1]=any(cols)) or cardinality(bits)>3 or (cardinality(bits)>1 and bits[2] not in ('asc','desc'))
        or (cardinality(bits)>2 and bits[3] not in ('nullsfirst','nullslast')) then
        raise exception using errcode='22023',message='Unsupported desktop order';end if;
       order_sql:=order_sql||case when order_sql='' then '' else ',' end||format('t.%I',bits[1])||' '||coalesce(bits[2],'asc')||
        case bits[3] when 'nullsfirst' then ' nulls first' when 'nullslast' then ' nulls last' else '' end;
      end loop;
     when 'limit' then
      if wrote or part !~ '^[0-9]{1,4}$' or part::integer not between 1 and 1000 then raise exception using errcode='22023',message='Invalid desktop limit';end if;
      limit_n:=part::integer;
     when 'offset' then
      if wrote or part !~ '^[0-9]{1,6}$' or part::integer not between 0 and 100000 then raise exception using errcode='22023',message='Invalid desktop offset';end if;
      offset_n:=part::integer;
     when 'on_conflict' then
      if p_method<>'POST' or part is distinct from desktop_worker_private.conflict_columns(p_resource) then
       raise exception using errcode='22023',message='Unsupported desktop conflict key';end if;
      conflict:=part;
    end case;
   elsif item.key='and' then
    if jsonb_typeof(item.value)<>'string' then raise exception using errcode='22023',message='Invalid desktop bounds';end if;
    part:=item.value#>>'{}';
    if left(part,1)<>'(' or right(part,1)<>')' or length(part)>4096 then raise exception using errcode='22023',message='Invalid desktop bounds';end if;
    foreach part in array string_to_array(substring(part from 2 for length(part)-2),',') loop
     column_name:=split_part(part,'.',1);
     conditions:=array_append(conditions,desktop_worker_private.predicate(column_name,substring(part from length(column_name)+2),cols));
    end loop;
   else
    if jsonb_typeof(item.value)='string' then
     conditions:=array_append(conditions,desktop_worker_private.predicate(item.key,item.value#>>'{}',cols));
    elsif jsonb_typeof(item.value)='array' and jsonb_array_length(item.value) between 1 and 8 then
     for value in select * from jsonb_array_elements(item.value) loop
      if jsonb_typeof(value)<>'string' then raise exception using errcode='22023',message='Invalid desktop repeated filter';end if;
      conditions:=array_append(conditions,desktop_worker_private.predicate(item.key,value#>>'{}',cols));
     end loop;
    else raise exception using errcode='22023',message='Invalid desktop filter';end if;
   end if;
  end loop;
  if p_resource='params' then
   conditions:=array_append(conditions,'t.key in (''environment'',''shiftDay'',''shiftNight'',''shiftAdvance'',''tzRules'')');
  end if;
  if cardinality(conditions)>0 then where_sql:=array_to_string(conditions,' and ');end if;
  select string_agg(format('t.%I',c),',') into select_sql from unnest(chosen) c;
  if p_method='GET' then
   if p_body is not null and p_body<>'null'::jsonb or resolution is not null then raise exception using errcode='22023',message='Invalid desktop read body';end if;
   execute format('select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb) from (select %s from public.%I t where %s%s limit %s offset %s) q',
    select_sql,p_resource,where_sql,case when order_sql='' then '' else ' order by '||order_sql end,limit_n,offset_n) into result;
   if count_exact then
    execute format('select count(*) from public.%I t where %s',p_resource,where_sql) into total;
    headers:=jsonb_build_object('content-range',case when jsonb_array_length(result)=0 then '*' else offset_n||'-'||(offset_n+jsonb_array_length(result)-1) end||'/'||total);
   end if;
  elsif p_method='POST' then
   if cardinality(conditions)>0 or (resolution is null)<>(conflict is null) then raise exception using errcode='22023',message='Unsupported desktop insert options';end if;
   rows:=case when jsonb_typeof(p_body)='object' then jsonb_build_array(p_body) else p_body end;
   if jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows) not between 1 and 1000 then raise exception using errcode='22023',message='Invalid desktop insert batch';end if;
   for row_body in select * from jsonb_array_elements(rows) loop
    if jsonb_typeof(row_body) is distinct from 'object' or row_body='{}'::jsonb then raise exception using errcode='22023',message='Invalid desktop row';end if;
    select array_agg(k order by k) into fields from jsonb_object_keys(row_body) k;
    if not(fields<@allowed) then raise exception using errcode='22023',message='Unsupported desktop write column';end if;
    select string_agg(format('%I',c),',') into sql from unnest(fields) c;
    conflict_sql:='';
    if conflict is not null then
     if not(string_to_array(conflict,',')<@fields) then raise exception using errcode='22023',message='Desktop conflict key missing';end if;
     select string_agg(format('%I',c),',') into conflict_sql from unnest(string_to_array(conflict,',')) c;
     conflict_sql:=' on conflict ('||conflict_sql||') do ';
     if resolution='resolution=ignore-duplicates' then conflict_sql:=conflict_sql||'nothing';
     else
      select string_agg(format('%1$I=excluded.%1$I',c),',') into sets from unnest(fields) c where not(c=any(string_to_array(conflict,',')));
      conflict_sql:=conflict_sql||case when sets is null then 'nothing' else 'update set '||sets end;
     end if;
    end if;
    execute format('with changed as (insert into public.%1$I (%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1)%3$s returning *) select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb) from (select %4$s from changed t) q',p_resource,sql,conflict_sql,select_sql)
     into result using row_body;
    results:=results||result;
   end loop;
   result:=case when return_rows then results else 'null'::jsonb end;
  else
   if cardinality(conditions)=0 or conflict is not null or resolution is not null then raise exception using errcode='22023',message='Desktop write requires a bounded selector';end if;
   -- Only selectors actually used by the collectors can mutate shared rows.
   if p_resource in ('fleet_sources','fleet_drivers','fleet_motion_alerts','fleet_rotation_sync','fleet_inventory_sync','uber_report_settings','ops_fuel_reference_runs') and coalesce(p_params->>'id','') !~ '^eq\.' then
    raise exception using errcode='22023',message='Desktop row selector required';end if;
   if p_resource='fleet_latest' and coalesce(p_params->>'source','') !~ '^eq\.' then raise exception using errcode='22023',message='Desktop source selector required';end if;
   if p_resource='fleet_alerts' and coalesce(p_params->>'id','') !~ '^eq\.' and not(coalesce(p_params->>'source','') ~ '^eq\.' and p_params->>'status'='eq.open') then raise exception using errcode='22023',message='Desktop alert selector required';end if;
   if p_resource in ('live_status','ops_fuel_checkpoints') and coalesce(p_params->>'vehicle_key','') !~ '^eq\.' then raise exception using errcode='22023',message='Desktop vehicle selector required';end if;
   if p_resource='vehicles' and (coalesce(p_params->>'key','') !~ '^eq\.' or p_params->>'geotab_id' is distinct from 'is.null' or p_params->>'geotab_auto_link_disabled' is distinct from 'eq.false') then
    raise exception using errcode='22023',message='Desktop automatic association guard required';end if;
   if p_resource in ('fleet_rotation_sync','fleet_inventory_sync','uber_report_settings','ops_fuel_reference_runs') and p_params->>'id' is distinct from 'eq.1' then raise exception using errcode='22023',message='Desktop singleton selector required';end if;
   execute format('select count(*) from public.%I t where %s',p_resource,where_sql) into affected;
   if affected>10000 then raise exception using errcode='22023',message='Desktop mutation too large';end if;
   if p_method='DELETE' then
    if p_body is not null and p_body<>'null'::jsonb then raise exception using errcode='22023',message='Invalid desktop delete body';end if;
    execute format('with changed as (delete from public.%I t where %s returning *) select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb) from (select %s from changed t) q',p_resource,where_sql,select_sql) into result;
   else
    if jsonb_typeof(p_body) is distinct from 'object' or p_body='{}'::jsonb then raise exception using errcode='22023',message='Invalid desktop update';end if;
    select array_agg(k order by k) into fields from jsonb_object_keys(p_body) k;
    if not(fields<@allowed) then raise exception using errcode='22023',message='Unsupported desktop write column';end if;
    if p_resource='fleet_drivers' then
     if p_body ? 'vehicle_key' then
      if p_body->'vehicle_key'<>'null'::jsonb or p_body->'vehicle_link_evidence' is distinct from '{}'::jsonb or p_params->>'auto_link_disabled' is distinct from 'eq.false'
       or coalesce(p_params->>'vehicle_link_method','') not in ('eq.platform_plate','eq.myclicar_contract') then raise exception using errcode='22023',message='Desktop automatic invalidation guard required';end if;
     elsif not(p_params ?& array['vehicle_key','vehicle_link_method','link_evidence','vehicle_link_evidence']) then
      raise exception using errcode='22023',message='Desktop evidence revision guard required';end if;
    end if;
    select string_agg(format('%1$I=patch.%1$I',c),',') into sets from unnest(fields) c;
    execute format('with changed as (update public.%1$I t set %2$s from jsonb_populate_record(null::public.%1$I,$1) patch where %3$s returning t.*) select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb) from (select %4$s from changed t) q',p_resource,sets,where_sql,select_sql) into result using p_body;
   end if;
   if not return_rows then result:='null'::jsonb;end if;
  end if;
 end if;
 if wrote and lease.expires_at<=clock_timestamp() then
  raise exception using errcode='55000',message='Desktop lease expired during operation';end if;
 return jsonb_build_object('status',case when p_method='GET' or left(p_resource,4)='rpc/' then 200 when p_method='POST' then 201 when return_rows then 200 else 204 end,
  'body',coalesce(result,'null'::jsonb),'headers',headers);
end $function$;

CREATE OR REPLACE FUNCTION public.desktop_worker_status(p_device_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin perform desktop_worker_private.device(p_device_id,false);return desktop_worker_private.state(p_device_id);end $function$;

CREATE OR REPLACE FUNCTION public.driver_portal_login(p_credential_hash text, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare account public.driver_portal_accounts; created timestamptz; expires timestamptz;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
 if p_credential_hash is null or p_credential_hash !~ '^[a-f0-9]{64}$'
  or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid credential digest';end if;
 select * into account from public.driver_portal_accounts where credential_hash=p_credential_hash and active for update;
 if not found then return null;end if;
 created:=clock_timestamp();expires:=created+interval '12 hours';
 delete from public.driver_portal_sessions where account_id=account.id and expires_at<=created;
 insert into public.driver_portal_sessions(token_hash,account_id,created_at,expires_at) values(p_token_hash,account.id,created,expires);
 return jsonb_build_object('name',account.display_name,'expires_at',expires);
end $function$;

CREATE OR REPLACE FUNCTION public.driver_portal_rotate(p_account uuid, p_credential_hash text, p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare account public.driver_portal_accounts;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
 if p_user is null or not exists(select 1 from public.profiles where user_id=p_user and role='admin') then raise exception 'Administrator required';end if;
 if p_account is null or p_credential_hash is not null and p_credential_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid access rotation';end if;
 select * into account from public.driver_portal_accounts where id=p_account for update;
 if not found then return null;end if;
 delete from public.driver_portal_sessions where account_id=account.id;
 update public.driver_portal_accounts set active=p_credential_hash is not null,
  credential_hash=coalesce(p_credential_hash,credential_hash),rotated_at=clock_timestamp() where id=account.id;
 return jsonb_build_object('ok',true,'active',p_credential_hash is not null);
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_archive_parking_zone(p_id uuid, p_revision bigint, p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare zone public.fleet_parking_zones;
begin
 if(select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
 if not exists(select 1 from public.profiles where user_id=p_user and role='admin') then raise exception 'Administrator required';end if;
 if p_id is null or p_revision is null or p_revision<=0 then raise exception 'Invalid zone or revision';end if;
 select * into zone from public.fleet_parking_zones where id=p_id for update;
 if not found then return jsonb_build_object('outcome','missing');end if;
 if zone.archived_at is not null or zone.revision<>p_revision then return jsonb_build_object('outcome','conflict');end if;
 -- The existing reset trigger increments revision and clears live/pending state.
 -- Events and their foreign key remain intact. Delayed detector commits fail
 -- their enabled/revision checks against the same locked zone row.
 update public.fleet_parking_zones set enabled=false,archived_at=now(),archived_by=p_user,updated_at=now()
  where id=p_id returning * into zone;
 return jsonb_build_object('outcome','archived','id',zone.id,'revision',zone.revision,'archived_at',zone.archived_at);
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_auto_link_driver(p_driver uuid, p_ludy_code text, p_platform_name text, p_ludy_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare old_row public.fleet_drivers%rowtype;ref_row public.drivers%rowtype;existing public.fleet_drivers%rowtype;target uuid;k text;proof jsonb;
begin
  if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production marker required';end if;
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into old_row from public.fleet_drivers where id=p_driver for update;
  if not found or old_row.auto_link_disabled or old_row.ludy_driver_code is not null or old_row.name is distinct from p_platform_name then return null;end if;
  select * into ref_row from public.drivers where code=p_ludy_code and name=p_ludy_name;
  if not found then return null;end if;
  k:=public.fleet_normalized_name(old_row.name);
  if k not like '% %' or k is distinct from public.fleet_normalized_name(ref_row.name)
    or (select count(*) from public.drivers where public.fleet_normalized_name(name)=k)<>1
    or old_row.agency_id is not null and ref_row.agency_id is distinct from old_row.agency_id then return null;end if;
  if exists(select 1 from public.fleet_identities own join public.fleet_identities other
    on own.source=other.source and own.organization_id is not distinct from other.organization_id and own.driver_id<>other.driver_id
    join public.fleet_drivers d on d.id=other.driver_id
    where own.driver_id=p_driver and public.fleet_normalized_name(d.name)=k) then return null;end if;
  select * into existing from public.fleet_drivers where ludy_driver_code=p_ludy_code for update;
  if existing.auto_link_disabled then return null;end if;
  target:=public.fleet_link_driver_base(p_driver,p_ludy_code,coalesce(existing.vehicle_key,old_row.vehicle_key),null);
  proof:=jsonb_build_object('method','exact_name','platform_name',p_platform_name,'ludy_name',p_ludy_name,'at',now());
  update public.fleet_drivers set link_method=coalesce(existing.link_method,'exact_name'),link_evidence=proof where id=target;
  insert into public.fleet_link_audit(driver_id,action,method,evidence)
    values(target,'associate','exact_name',proof||jsonb_build_object('previous_driver_id',p_driver,'ludy_driver_code',p_ludy_code));
  return target;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_auto_link_driver_spacing(p_driver uuid, p_ludy_code text, p_platform_name text, p_ludy_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  if exists(select 1 from public.fleet_drivers where ludy_driver_code=p_ludy_code and auto_link_disabled) then return null;end if;
  return public.fleet_auto_link_driver_spacing_base(p_driver,p_ludy_code,p_platform_name,p_ludy_name);
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_auto_link_driver_spacing_base(p_driver uuid, p_ludy_code text, p_platform_name text, p_ludy_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare old_row fleet_drivers%rowtype; ref_row drivers%rowtype; existing fleet_drivers%rowtype; target uuid; k text; proof jsonb;
begin
  if (select value from params where key='environment') is distinct from 'production' then raise exception 'Production marker required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into old_row from fleet_drivers where id=p_driver for update;
  if not found or old_row.auto_link_disabled or old_row.ludy_driver_code is not null or old_row.name is distinct from p_platform_name then return null; end if;
  select * into ref_row from drivers where code=p_ludy_code and name=p_ludy_name;
  if not found then return null; end if;
  k:=fleet_spaced_name_key(old_row.name);
  if length(k)<8 or k!~'^[[:alpha:]]+$' or k is distinct from fleet_spaced_name_key(ref_row.name)
    or old_row.name!~'[[:alpha:]][[:space:]-]+[[:alpha:]]' or ref_row.name!~'[[:alpha:]][[:space:]-]+[[:alpha:]]'
    or (select count(*) from drivers where fleet_spaced_name_key(name)=k)<>1
    or old_row.agency_id is not null and ref_row.agency_id is distinct from old_row.agency_id then return null; end if;
  if exists(select 1 from fleet_identities own join fleet_identities other
      on own.source=other.source and own.organization_id is not distinct from other.organization_id and own.driver_id<>other.driver_id
      join fleet_drivers d on d.id=other.driver_id where own.driver_id=p_driver and fleet_spaced_name_key(d.name)=k) then return null; end if;
  select * into existing from fleet_drivers where ludy_driver_code=p_ludy_code;
  target:=fleet_link_driver_base(p_driver,p_ludy_code,coalesce(existing.vehicle_key,old_row.vehicle_key),null);
  proof:=jsonb_build_object('method','name_spacing','platform_name',p_platform_name,'ludy_name',p_ludy_name,'at',now());
  update fleet_drivers set link_method=coalesce(existing.link_method,'name_spacing'),link_evidence=proof where id=target;
  insert into fleet_link_audit(driver_id,action,method,evidence) values(target,'associate','name_spacing',proof||jsonb_build_object('previous_driver_id',p_driver,'ludy_driver_code',p_ludy_code));
  return target;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_auto_link_myclicar_vehicle(p_driver uuid, p_contract_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.fleet_myclicar_contracts%rowtype; d public.fleet_drivers%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into c from public.fleet_myclicar_contracts where external_id=p_contract_id;
  if not found then return false; end if;
  select * into d from public.fleet_drivers where id=p_driver;
  if not found then return false; end if;
  if exists(select 1 from public.fleet_contract_assignment_overrides o where o.contract_id=c.external_id
      and (o.client_code,o.vehicle_key,o.effective_start_at)=(c.client_code,c.vehicle_key,c.effective_start_at)) then return false; end if;
  -- This also protects the gap before the next reconciliation, including a
  -- newly discovered profile whose Ludy identity is not known yet.
  if exists(select 1 from public.fleet_current_vehicle_claims() x
      where c.vehicle_key=any(x.vehicle_keys) and x.driver_id<>p_driver
        and x.client_code is distinct from d.ludy_driver_code) then return false; end if;
  return public.fleet_auto_link_myclicar_vehicle_contract_base(p_driver,p_contract_id);
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_auto_link_myclicar_vehicle_contract_base(p_driver uuid, p_contract_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d public.fleet_drivers%rowtype;
  c public.fleet_myclicar_contracts%rowtype;
  s public.fleet_sources%rowtype;
  expiry timestamptz;
  proof jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into d from public.fleet_drivers where id=p_driver for update;
  if not found or d.auto_link_disabled or d.ludy_driver_code is null or d.vehicle_link_method='manual'
    or d.vehicle_key is not null and d.vehicle_link_method is null then return false; end if;
  select * into c from public.fleet_myclicar_contracts where external_id=p_contract_id;
  if not found or not c.current or not c.eligible or c.client_code is distinct from d.ludy_driver_code
    or c.status<>'IN_PROGRESS' or c.deleted or c.end_at is not null
    or c.effective_start_at is null or c.effective_start_at>now()
    or c.observed_at>now()+interval '5 seconds' then return false; end if;
  select * into s from public.fleet_sources where id='myclicar';
  if s.status is distinct from 'healthy' or s.last_success_at is null
    or s.last_success_at>now()+interval '5 seconds' then return false; end if;
  expiry:=least(c.observed_at,s.last_success_at)+make_interval(secs=>least(s.stale_after_s,300));
  if expiry<=now() then return false; end if;
  if not exists(
    select 1 from public.vehicles v join public.drivers r on r.code=d.ludy_driver_code
    where v.key=c.vehicle_key and upper(coalesce(v.active,'OUI'))<>'NON'
      and (r.agency_id is null or r.agency_id=v.agency_id)
      and (d.agency_id is null or d.agency_id=v.agency_id)
  ) then return false; end if;
  if exists(
    select 1 from public.fleet_myclicar_contracts other
    where other.current and other.external_id<>c.external_id and other.status='IN_PROGRESS'
      and not other.deleted and other.end_at is null and other.effective_start_at<=now()
      and (other.client_code=c.client_code or c.vehicle_key=any(other.vehicle_candidates))
  ) then return false; end if;

  -- Only a recent online vehicle observation can contradict the current contract.
  -- Uber details may be cached for 180 s, but the status/source must stay fresh.
  if exists(
    select 1 from public.fleet_latest l join public.fleet_sources src on src.id=l.source
    where l.driver_id=d.id and coalesce(l.vehicle_label,'')<>''
      and public.fleet_vehicle_observation_current(
        l.source,l.status,l.observed_at,l.evidence,src.status,src.last_success_at,src.stale_after_s
      )
      and not exists(
        select 1 from public.vehicles v,
          unnest(array[v.key,v.plate]||regexp_split_to_array(coalesce(v.other_plates,''),'[,;]')) alias
        where v.key=c.vehicle_key
          and public.fleet_myclicar_plate(alias)=public.fleet_myclicar_plate(l.vehicle_label)
      )
  ) then return false; end if;

  update public.fleet_drivers set vehicle_key=null,vehicle_link_evidence='{}'
    where id<>p_driver and vehicle_key=c.vehicle_key
      and vehicle_link_method in ('platform_plate','myclicar_contract') and not auto_link_disabled
      and coalesce((vehicle_link_evidence->>'expires_at')::timestamptz,'-infinity'::timestamptz)<=now();
  if exists(select 1 from public.fleet_drivers where id<>p_driver and vehicle_key=c.vehicle_key) then return false; end if;
  proof:=jsonb_build_object(
    'method','myclicar_contract','source','myclicar','contract_id',c.external_id,'contract_num',c.num,
    'client_code',c.client_code,'vehicle_key',c.vehicle_key,'observed_at',c.observed_at,'expires_at',expiry
  );
  if d.vehicle_key is distinct from c.vehicle_key or d.vehicle_link_method is distinct from 'myclicar_contract'
    or d.vehicle_link_evidence->>'contract_id' is distinct from c.external_id then
    insert into public.fleet_link_audit(driver_id,action,method,evidence)
      values(p_driver,'vehicle','myclicar_contract',proof||jsonb_build_object('previous_vehicle_key',d.vehicle_key));
  end if;
  update public.fleet_drivers
    set vehicle_key=c.vehicle_key,vehicle_link_method='myclicar_contract',vehicle_link_evidence=proof
    where id=p_driver;
  return true;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_auto_link_vehicle(p_driver uuid, p_vehicle_key text, p_evidence jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d public.fleet_drivers%rowtype; stamp timestamptz; expiry timestamptz; claimant text; valid boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into d from public.fleet_drivers where id=p_driver for update;
  if not found or d.auto_link_disabled or d.ludy_driver_code is null or d.vehicle_link_method='manual'
    or (d.vehicle_key is not null and d.vehicle_link_method is null) then return false; end if;
  begin stamp:=(p_evidence->>'observed_at')::timestamptz; expiry:=(p_evidence->>'expires_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then return false; end;
  if p_evidence->>'method' is distinct from 'platform_plate' or stamp is null or expiry is null
    or not isfinite(stamp) or not isfinite(expiry) or expiry<=now() or expiry<=stamp
    or expiry>now()+interval '4 minutes'
    or p_evidence->>'source'='bolt' and p_evidence->>'vehicle_origin' is distinct from 'bolt_live' then return false; end if;
  if not exists(select 1 from public.vehicles v join public.drivers r on r.code=d.ludy_driver_code
      where v.key=p_vehicle_key and upper(coalesce(v.active,'OUI'))<>'NON'
      and (r.agency_id is null or r.agency_id=v.agency_id)
      and (d.agency_id is null or d.agency_id=v.agency_id)) then return false; end if;
  claimant:='ludy:'||d.ludy_driver_code;
  with claims as materialized(select * from public.fleet_current_vehicle_claims())
    select exists(select 1 from claims x where x.driver_id=p_driver and x.source=p_evidence->>'source'
        and cardinality(x.vehicle_keys)=1 and x.vehicle_keys[1]=p_vehicle_key and x.observed_at=stamp and expiry<=x.expires_at)
      and not exists(select 1 from claims x where x.person=claimant
        and (cardinality(x.vehicle_keys)<>1 or x.vehicle_keys[1]<>p_vehicle_key))
      and not exists(select 1 from claims x where x.person<>claimant and p_vehicle_key=any(x.vehicle_keys)) into valid;
  if not valid then return false; end if;
  perform public.fleet_reconcile_vehicle_contracts();
  -- A stored automatic lease is not a second live claim. Release it immediately
  -- after a coherent shift, without waiting for its old timeout to elapse.
  insert into public.fleet_link_audit(driver_id,action,method,evidence)
    select id,'vehicle_revoke','platform_shift',jsonb_build_object('vehicle_key',vehicle_key,'next_driver_id',p_driver)
    from public.fleet_drivers where id<>p_driver and vehicle_key=p_vehicle_key
      and vehicle_link_method in('platform_plate','myclicar_contract') and not auto_link_disabled;
  delete from public.fleet_motion_checkpoints checkpoint using public.fleet_identities i,public.fleet_drivers old
    where checkpoint.identity_id=i.id and i.driver_id=old.id and old.id<>p_driver
      and old.vehicle_key=p_vehicle_key and old.vehicle_link_method in('platform_plate','myclicar_contract') and not old.auto_link_disabled;
  update public.fleet_drivers set vehicle_key=null,vehicle_link_evidence='{}'
    where id<>p_driver and vehicle_key=p_vehicle_key
      and vehicle_link_method in('platform_plate','myclicar_contract') and not auto_link_disabled;
  return public.fleet_auto_link_vehicle_platform_base(p_driver,p_vehicle_key,p_evidence);
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_auto_link_vehicle_platform_base(p_driver uuid, p_vehicle_key text, p_evidence jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare current_row fleet_drivers%rowtype; expiry timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into current_row from fleet_drivers where id=p_driver for update;
  if not found or current_row.auto_link_disabled or current_row.ludy_driver_code is null or current_row.vehicle_link_method='manual'
    or (current_row.vehicle_key is not null and current_row.vehicle_link_method is null) then return false; end if;
  expiry := (p_evidence->>'expires_at')::timestamptz;
  if p_evidence->>'method' is distinct from 'platform_plate' or coalesce(p_evidence->>'source','') not in ('uber','bolt')
    or expiry is null or expiry<=now() or expiry>now()+interval '4 minutes' then return false; end if;
  if not exists(select 1 from vehicles where key=p_vehicle_key and active is distinct from 'NON'
    and (current_row.agency_id is null or agency_id=current_row.agency_id)) then return false; end if;
  -- A stale automatic claim cannot hold a car forever after a shift change.
  update fleet_drivers set vehicle_key=null,vehicle_link_evidence='{}'::jsonb
    where id<>p_driver and vehicle_key=p_vehicle_key and vehicle_link_method='platform_plate'
      and (vehicle_link_evidence->>'expires_at')::timestamptz<=now();
  if exists(select 1 from fleet_drivers where id<>p_driver and vehicle_key=p_vehicle_key) then return false; end if;
  if current_row.vehicle_key is distinct from p_vehicle_key then
    insert into fleet_link_audit(driver_id,action,method,evidence) values(p_driver,'vehicle','platform_plate',p_evidence||jsonb_build_object('vehicle_key',p_vehicle_key,'previous_vehicle_key',current_row.vehicle_key));
  end if;
  update fleet_drivers set vehicle_key=p_vehicle_key,vehicle_link_method='platform_plate',vehicle_link_evidence=p_evidence where id=p_driver;
  return true;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_can_read(p_driver uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select public.is_admin() or (public.my_role() in ('manager','viewer') and exists(
   select 1 from fleet_drivers d where d.id=p_driver and d.agency_id=any(public.my_agency_ids())
 )) $function$;

CREATE OR REPLACE FUNCTION public.fleet_commit_disconnections(p_states jsonb, p_alerts jsonb, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare added integer:=0; changed integer:=0; saved integer:=0; removed integer:=0;
begin
  if (select value from public.params where key='environment') is distinct from 'production' then
    raise exception 'Production marker required';
  end if;
  if p_states is null or jsonb_typeof(p_states)<>'array' or jsonb_array_length(p_states)>5000
    or p_alerts is null or jsonb_typeof(p_alerts)<>'array' or jsonb_array_length(p_alerts)>5000
    or p_changes is null or jsonb_typeof(p_changes)<>'array' or jsonb_array_length(p_changes)>5000
    or pg_column_size(p_states)+pg_column_size(p_alerts)+pg_column_size(p_changes)>16777216 then
    raise exception 'Lot de déconnexions invalide';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  perform pg_advisory_xact_lock(hashtextextended('fleet-disconnections',0));
  if exists(select 1 from jsonb_array_elements(p_states) x where jsonb_typeof(x)<>'object')
    or exists(select 1 from jsonb_array_elements(p_alerts) x where jsonb_typeof(x)<>'object')
    or exists(select 1 from jsonb_array_elements(p_changes) x where jsonb_typeof(x)<>'object') then
    raise exception 'Éléments du lot de déconnexions invalides';
  end if;
  if exists(select 1 from jsonb_array_elements(p_states) x, jsonb_object_keys(x) k where k not in('identity_id','state','updated_at'))
    or exists(select 1 from jsonb_array_elements(p_alerts) x,jsonb_object_keys(x) k where k not in(
      'id','identity_id','driver_id','source','vehicle_key','contract_id','duty_key','observed_online_at','disconnected_at',
      'opened_at','last_seen_at','status','resolved_at','evidence'))
    or exists(select 1 from jsonb_array_elements(p_changes) x,jsonb_object_keys(x) k where k not in('id','status','last_seen_at','resolved_at')) then
    raise exception 'Champs de déconnexions non autorisés';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_states) as x(identity_id uuid,state jsonb,updated_at timestamptz)
      left join public.fleet_identities i on i.id=x.identity_id
      where x.identity_id is null or i.id is null or i.source not in('uber','bolt')
        or x.state is null or jsonb_typeof(x.state)<>'object' or pg_column_size(x.state)>32768
        or x.updated_at is null or not isfinite(x.updated_at) or x.updated_at>now()+interval '5 seconds'
        or x.state ? 'identity_id' and x.state->>'identity_id' is distinct from x.identity_id::text
        or x.state ? 'source' and x.state->>'source' is distinct from i.source)
    or exists(select 1 from jsonb_to_recordset(p_states) as x(identity_id uuid) group by identity_id having count(*)>1) then
    raise exception 'Checkpoints de déconnexion invalides';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_states) as x(identity_id uuid,state jsonb,updated_at timestamptz)
      join public.fleet_identities i on i.id=x.identity_id
      where not x.state ?& array['version','identity_id','driver_id','source','duty_key','policy','status','observed_at','online_at','offline_at']
        or x.state->'version' is distinct from '1'::jsonb
        or x.state->>'driver_id' is distinct from i.driver_id::text
        or jsonb_typeof(x.state->'duty_key') is distinct from 'string' or length(btrim(x.state->>'duty_key')) not between 1 and 500
        or coalesce(x.state->>'policy','') not in('any','all')
        or coalesce(x.state->>'status','') not in('available','on_trip','to_pickup','on_break','offline')
        or jsonb_typeof(x.state->'observed_at') is distinct from 'string'
        or jsonb_typeof(x.state->'online_at') not in('string','null')
        or jsonb_typeof(x.state->'offline_at') not in('string','null'))
    or exists(select 1 from jsonb_array_elements(p_states) x,jsonb_object_keys(x->'state') k
      where k not in('version','identity_id','driver_id','source','duty_key','policy','status','observed_at','online_at','offline_at')) then
    raise exception 'État du détecteur de déconnexion invalide';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_states) as x(state jsonb,updated_at timestamptz)
      where not isfinite((x.state->>'observed_at')::timestamptz)
        or (x.state->>'observed_at')::timestamptz>x.updated_at+interval '5 seconds'
        or x.state->>'online_at' is not null and (not isfinite((x.state->>'online_at')::timestamptz)
          or (x.state->>'online_at')::timestamptz>(x.state->>'observed_at')::timestamptz)
        or x.state->>'offline_at' is not null and (not isfinite((x.state->>'offline_at')::timestamptz)
          or (x.state->>'offline_at')::timestamptz>(x.state->>'observed_at')::timestamptz)) then
    raise exception 'Horodatages du détecteur de déconnexion invalides';
  end if;
  if exists(select 1 from jsonb_populate_recordset(null::public.fleet_disconnection_alerts,p_alerts) x
      left join public.fleet_identities i on i.id=x.identity_id
      where x.identity_id is null or i.id is null or x.driver_id is distinct from i.driver_id or x.source is distinct from i.source
        or x.source not in('uber','bolt') or x.duty_key is null or length(btrim(x.duty_key)) not between 1 and 500
        or x.contract_id is not null and length(x.contract_id) not between 1 and 120
        or x.vehicle_key is not null and not exists(select 1 from public.vehicles v where v.key=x.vehicle_key)
        or x.observed_online_at is null or not isfinite(x.observed_online_at)
        or x.disconnected_at is null or not isfinite(x.disconnected_at) or x.disconnected_at<=x.observed_online_at
        or x.disconnected_at>now()+interval '5 seconds'
        or coalesce(x.opened_at,now())>now()+interval '5 seconds' or not isfinite(coalesce(x.opened_at,now()))
        or coalesce(x.last_seen_at,now())>now()+interval '5 seconds' or not isfinite(coalesce(x.last_seen_at,now()))
        or coalesce(x.last_seen_at,now())<x.disconnected_at-interval '5 seconds'
        or coalesce(x.status,'open')<>'open' or x.resolved_at is not null
        or x.evidence is null or jsonb_typeof(x.evidence)<>'object' or pg_column_size(x.evidence)>32768
        or x.evidence->>'kind' is distinct from 'platform_disconnection'
        or coalesce(x.evidence->>'policy','') not in('any','all')
        or x.evidence ? 'duty' and jsonb_typeof(x.evidence->'duty') is distinct from 'object')
    or exists(select 1 from jsonb_to_recordset(p_alerts) as x(identity_id uuid,disconnected_at timestamptz,duty_key text)
      group by identity_id,disconnected_at,duty_key having count(*)>1) then
    raise exception 'Preuves de déconnexion invalides';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_changes) as x(id uuid,status text,last_seen_at timestamptz,resolved_at timestamptz)
      left join public.fleet_disconnection_alerts a on a.id=x.id
      where x.id is null or a.id is null or x.status is null or x.status not in('open','suspended','resolved')
        or a.status='resolved' and x.status<>'resolved'
        or x.last_seen_at is null or not isfinite(x.last_seen_at) or x.last_seen_at>now()+interval '5 seconds'
        or x.last_seen_at<a.last_seen_at or x.last_seen_at<a.disconnected_at-interval '5 seconds'
        or x.status='resolved' and (x.resolved_at is null or not isfinite(x.resolved_at)
          or x.resolved_at<a.disconnected_at or x.resolved_at>now()+interval '5 seconds' or x.resolved_at>x.last_seen_at+interval '5 seconds')
        or x.status<>'resolved' and x.resolved_at is not null)
    or exists(select 1 from jsonb_to_recordset(p_changes) as x(id uuid) group by id having count(*)>1) then
    raise exception 'Transitions de déconnexion invalides';
  end if;
  -- Identical event replays preserve the original ID, proof and lifecycle.
  insert into public.fleet_disconnection_alerts(id,identity_id,driver_id,source,vehicle_key,contract_id,duty_key,
      observed_online_at,disconnected_at,opened_at,last_seen_at,status,evidence)
    select coalesce(x.id,gen_random_uuid()),x.identity_id,x.driver_id,x.source,x.vehicle_key,x.contract_id,x.duty_key,
      x.observed_online_at,x.disconnected_at,coalesce(x.opened_at,now()),coalesce(x.last_seen_at,now()),'open',coalesce(x.evidence,'{}')
    from jsonb_populate_recordset(null::public.fleet_disconnection_alerts,p_alerts) x
    on conflict(identity_id,disconnected_at,duty_key) do nothing;
  get diagnostics added=row_count;
  update public.fleet_disconnection_alerts a set status=x.status,last_seen_at=x.last_seen_at,resolved_at=x.resolved_at
    from jsonb_to_recordset(p_changes) as x(id uuid,status text,last_seen_at timestamptz,resolved_at timestamptz)
    where a.id=x.id and (a.status,a.last_seen_at,a.resolved_at) is distinct from (x.status,x.last_seen_at,x.resolved_at);
  get diagnostics changed=row_count;
  delete from public.fleet_disconnection_checkpoints c
    where c.identity_id is not null and not exists(
      select 1 from jsonb_to_recordset(p_states) as x(identity_id uuid) where x.identity_id=c.identity_id);
  get diagnostics removed=row_count;
  insert into public.fleet_disconnection_checkpoints(identity_id,state,updated_at)
    select x.identity_id,x.state,x.updated_at from jsonb_to_recordset(p_states) as x(identity_id uuid,state jsonb,updated_at timestamptz)
    on conflict(identity_id) do update set state=excluded.state,updated_at=excluded.updated_at;
  get diagnostics saved=row_count;
  return jsonb_build_object('alerts_created',added,'changes_applied',changed,'states_saved',saved,'states_removed',removed);
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_commit_parking(p_states jsonb, p_events jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare row jsonb; current_zone public.fleet_parking_zones; old_state jsonb; device text; has_old boolean; state_time timestamptz;
begin
 if(select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
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
   if row->'state'->>'outside_confirmed_at' is not null then
    if current_zone.kind<>'operating' or row->'state'->>'zone_id' is not null
     or coalesce((row->'state'->>'outside_samples')::integer,0)<2
     or row->'state'->>'outside_from_at' is null
     or not isfinite((row->'state'->>'outside_from_at')::timestamptz)
     or not isfinite((row->'state'->>'outside_confirmed_at')::timestamptz)
     or (row->'state'->>'outside_confirmed_at')::timestamptz-(row->'state'->>'outside_from_at')::timestamptz<interval '5 seconds'
     or (row->'state'->>'outside_confirmed_at')::timestamptz>state_time then raise exception 'Unconfirmed outside observation';end if;
   end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_current_vehicle_claims()
 RETURNS TABLE(identity_id uuid, driver_id uuid, client_code text, person text, vehicle_keys text[], source text, observed_at timestamp with time zone, expires_at timestamp with time zone, vehicle_label text, evidence jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; stamp timestamptz; ttl integer;
begin
  for r in
    select l.*,d.ludy_driver_code,s.status source_status,s.last_success_at,s.stale_after_s
    from public.fleet_latest l join public.fleet_drivers d on d.id=l.driver_id
    join public.fleet_identities i on i.id=l.identity_id and i.driver_id=l.driver_id and i.source=l.source
    join public.fleet_sources s on s.id=l.source
    where coalesce(l.vehicle_label,'')<>''
  loop
    if not public.fleet_vehicle_observation_current(r.source,r.status,r.observed_at,r.evidence,
        r.source_status,r.last_success_at,r.stale_after_s) then continue; end if;
    stamp:=r.observed_at; ttl:=least(r.stale_after_s,180);
    if r.source='uber' and r.evidence->>'vehicle_observed_at' is not null then
      stamp:=(r.evidence->>'vehicle_observed_at')::timestamptz; ttl:=180;
    end if;
    identity_id:=r.identity_id; driver_id:=r.driver_id; client_code:=r.ludy_driver_code;
    person:=case when r.ludy_driver_code is not null then 'ludy:'||r.ludy_driver_code else 'profile:'||r.driver_id::text end;
    select coalesce(array_agg(v.key order by v.key),'{}'::text[]) into vehicle_keys from public.vehicles v
    where upper(coalesce(v.active,'OUI'))<>'NON' and exists(
      select 1 from unnest(array[v.key,v.plate]||regexp_split_to_array(coalesce(v.other_plates,''),'[,;]')) alias
      where public.fleet_myclicar_plate(alias)<>''
        and public.fleet_myclicar_plate(alias)=public.fleet_myclicar_plate(r.vehicle_label));
    source:=r.source; observed_at:=stamp; expires_at:=stamp+make_interval(secs=>ttl);
    vehicle_label:=r.vehicle_label; evidence:=r.evidence;
    return next;
  end loop;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_import_bolt_performance(p_org text, p_rows jsonb, p_coverage jsonb, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare entry jsonb; coverage jsonb; target uuid; f timestamptz; t timestamptz; n integer:=0;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_link_driver(p_driver uuid, p_ludy_code text, p_vehicle_key text DEFAULT NULL::text, p_agency_id bigint DEFAULT NULL::bigint)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare target uuid;
begin
  target := public.fleet_link_driver_base(p_driver,p_ludy_code,p_vehicle_key,p_agency_id);
  update fleet_drivers set link_method='manual',auto_link_disabled=true,vehicle_link_method='manual',
    vehicle_link_evidence='{}'::jsonb,link_evidence=jsonb_build_object('at',now(),'method','manual') where id=target;
  insert into fleet_link_audit(driver_id,action,method,evidence) values(target,'associate','manual',jsonb_build_object('ludy_driver_code',p_ludy_code,'vehicle_key',p_vehicle_key));
  return target;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_link_driver_automatic(p_driver uuid, p_ludy_code text, p_agency_id bigint DEFAULT NULL::bigint)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare target uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  if p_ludy_code is null or not exists(select 1 from public.drivers where code=p_ludy_code) then
    raise exception 'Fiche Ludy obligatoire pour le suivi automatique';
  end if;
  target:=public.fleet_link_driver(p_driver,p_ludy_code,null,p_agency_id);
  update public.fleet_drivers set auto_link_disabled=false,vehicle_link_method=null,vehicle_key=null,
    vehicle_link_evidence='{}' where id=target;
  delete from public.fleet_motion_checkpoints checkpoint using public.fleet_identities i
    where checkpoint.identity_id=i.id and i.driver_id=target;
  insert into public.fleet_link_audit(driver_id,action,method,evidence)
    values(target,'vehicle_mode','automatic',jsonb_build_object('ludy_driver_code',p_ludy_code,'vehicle_mode','automatic'));
  return target;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_link_driver_base(p_driver uuid, p_ludy_code text, p_vehicle_key text DEFAULT NULL::text, p_agency_id bigint DEFAULT NULL::bigint)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare target uuid;
begin
  if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production marker required';end if;
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select id into target from public.fleet_drivers where ludy_driver_code=p_ludy_code for update;
  if target is not null and target<>p_driver then
    insert into public.fleet_driver_performance_sync as existing
      (source,organization_id,driver_id,covered_from,covered_to,last_attempt_at,last_success_at,status,row_count,last_error)
    select source,organization_id,target,covered_from,covered_to,last_attempt_at,last_success_at,status,row_count,last_error
      from public.fleet_driver_performance_sync where driver_id=p_driver
    on conflict(source,organization_id,driver_id) do update set
      covered_from=excluded.covered_from,covered_to=excluded.covered_to,last_attempt_at=excluded.last_attempt_at,
      last_success_at=excluded.last_success_at,status=excluded.status,row_count=excluded.row_count,last_error=excluded.last_error
    where coalesce(excluded.last_success_at,excluded.last_attempt_at,'-infinity')>coalesce(existing.last_success_at,existing.last_attempt_at,'-infinity');
    insert into public.fleet_driver_report_summaries as existing
      (source,organization_id,driver_id,report_type,period_from,period_to,reported_at,trips_completed,online_seconds,trip_seconds,
       acceptance_rate,cancellation_rate,completion_rate,accepted_count,rejected_count,cancelled_count)
    select source,organization_id,target,report_type,period_from,period_to,reported_at,trips_completed,online_seconds,trip_seconds,
       acceptance_rate,cancellation_rate,completion_rate,accepted_count,rejected_count,cancelled_count
      from public.fleet_driver_report_summaries where driver_id=p_driver
    on conflict(source,organization_id,driver_id,report_type,period_from,period_to) do update set
      reported_at=excluded.reported_at,trips_completed=excluded.trips_completed,online_seconds=excluded.online_seconds,
      trip_seconds=excluded.trip_seconds,acceptance_rate=excluded.acceptance_rate,cancellation_rate=excluded.cancellation_rate,
      completion_rate=excluded.completion_rate,accepted_count=excluded.accepted_count,rejected_count=excluded.rejected_count,cancelled_count=excluded.cancelled_count
    where excluded.reported_at>existing.reported_at;
    update public.fleet_link_audit set driver_id=target where driver_id=p_driver;
  end if;
  return public.fleet_link_driver_reference_base(p_driver,p_ludy_code,p_vehicle_key,p_agency_id);
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_link_driver_reference_base(p_driver uuid, p_ludy_code text, p_vehicle_key text DEFAULT NULL::text, p_agency_id bigint DEFAULT NULL::bigint)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare old_row fleet_drivers%rowtype; target uuid; base_driver drivers%rowtype; linked_agency bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  select * into old_row from fleet_drivers where id=p_driver for update;
  if not found then raise exception 'Chauffeur local introuvable'; end if;
  if p_ludy_code is not null then
    select * into base_driver from drivers where code=p_ludy_code;
    if not found then raise exception 'Chauffeur Ludy introuvable'; end if;
    linked_agency := base_driver.agency_id;
    select id into target from fleet_drivers where ludy_driver_code=p_ludy_code for update;
  else linked_agency := coalesce(p_agency_id,old_row.agency_id);
  end if;
  target := coalesce(target,p_driver);
  if p_vehicle_key is not null then
    if not exists(select 1 from vehicles where key=p_vehicle_key and (linked_agency is null or agency_id=linked_agency)) then
      raise exception 'Véhicule absent ou agence différente';
    end if;
    if exists(select 1 from fleet_drivers where vehicle_key=p_vehicle_key and id not in (p_driver,target)) then
      raise exception 'Véhicule déjà affecté à un autre chauffeur';
    end if;
  end if;
  if target <> p_driver then
    update fleet_identities set driver_id=target where driver_id=p_driver;
    update fleet_observations set driver_id=target where driver_id=p_driver;
    update fleet_latest set driver_id=target where driver_id=p_driver;
    update fleet_alerts set driver_id=target where driver_id=p_driver;
    update fleet_motion_alerts set driver_id=target where driver_id=p_driver;
    update fleet_rides set driver_id=target where driver_id=p_driver;
    delete from fleet_drivers where id=p_driver;
  end if;
  update fleet_drivers set ludy_driver_code=p_ludy_code,agency_id=linked_agency,
    name=case when p_ludy_code is not null then coalesce(base_driver.name,name) else name end,
    vehicle_key=p_vehicle_key where id=target;
  return target;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_myclicar_agency_label(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 select lower(regexp_replace(regexp_replace(trim(coalesce(p_value,'')),'^(agence|agency)\s+','','i'),'\s+',' ','g'))
$function$;

CREATE OR REPLACE FUNCTION public.fleet_myclicar_plate(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select regexp_replace(upper(coalesce(p_value,'')),'[^0-9]','','g') ||
    regexp_replace(upper(coalesce(p_value,'')),'[^A-Z]','','g')
$function$;

CREATE OR REPLACE FUNCTION public.fleet_normalized_name(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(string_agg(token,' ' order by token collate "C"),'')
  from regexp_split_to_table(lower(regexp_replace(normalize(coalesce(p_name,''),NFKD),U&'[\0300-\036f]','','g')),'[^[:alnum:]]+') token
  where token<>''
$function$;

CREATE OR REPLACE FUNCTION public.fleet_parking_zone_reset()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 if(select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
 new.revision:=old.revision+1;
 delete from public.fleet_parking_state where zone_id=old.id;
 return new;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_preserve_disconnections_on_merge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.fleet_disconnection_alerts a set driver_id=i.driver_id
    from public.fleet_identities i where a.driver_id=old.id and i.id=a.identity_id and i.driver_id<>old.id;
  update public.fleet_disconnection_checkpoints c set state=jsonb_set(c.state,'{driver_id}',to_jsonb(i.driver_id::text))
    from public.fleet_identities i where i.id=c.identity_id and i.driver_id<>old.id
      and c.state->>'driver_id'=old.id::text;
  return old;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_reconcile_vehicle_contracts()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_reconcile_vehicle_contracts_identity_base()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_reconcile_vehicle_contracts_shift_base()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare changed integer:=0; revoked integer:=0;
begin
  if (select value from public.params where key='environment') is distinct from 'production' then
    raise exception 'Production marker required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  with claims as materialized (select * from public.fleet_current_vehicle_claims()), unique_plates as (
    -- Contradiction suspends fallback; it never chooses a winner between two
    -- competing live claims. Their later expiry must not revive an old contract.
    select x.* from claims x where cardinality(x.vehicle_keys)=1
  ), contradictions as (
    select distinct on(c.external_id) c.external_id,c.client_code,c.vehicle_key,c.effective_start_at,
      x.observed_at,jsonb_build_object('method','platform_shift','source',x.source,'driver_id',x.driver_id,
        'client_code',x.client_code,'vehicle_key',x.vehicle_keys[1],'vehicle_label',x.vehicle_label,
        'observed_at',x.observed_at,'reason',case when x.vehicle_keys[1]=c.vehicle_key then 'other_driver' else 'other_vehicle' end) evidence
    from public.fleet_myclicar_contracts c join unique_plates x on
      (x.vehicle_keys[1]=c.vehicle_key and x.client_code is distinct from c.client_code)
      or (x.client_code=c.client_code and x.vehicle_keys[1]<>c.vehicle_key)
    where c.current and c.status='IN_PROGRESS' and not c.deleted and c.end_at is null
      and c.client_code is not null and c.vehicle_key is not null and c.effective_start_at<=now()
    order by c.external_id,x.observed_at desc,x.identity_id
  ) insert into public.fleet_contract_assignment_overrides as existing
      (contract_id,client_code,vehicle_key,effective_start_at,observed_at,evidence)
    select external_id,client_code,vehicle_key,effective_start_at,observed_at,evidence from contradictions
    on conflict(contract_id) do update set client_code=excluded.client_code,vehicle_key=excluded.vehicle_key,
      effective_start_at=excluded.effective_start_at,observed_at=excluded.observed_at,evidence=excluded.evidence
    where (existing.client_code,existing.vehicle_key,existing.effective_start_at)
      is distinct from (excluded.client_code,excluded.vehicle_key,excluded.effective_start_at);
  get diagnostics changed=row_count;

  -- Revoke only the displaced automatic lease. Manual assignments remain manual.
  with displaced as (
    select d.id,d.vehicle_key,d.vehicle_link_evidence from public.fleet_drivers d
    join public.fleet_myclicar_contracts c on c.external_id=d.vehicle_link_evidence->>'contract_id'
    join public.fleet_contract_assignment_overrides o on o.contract_id=c.external_id
      and (o.client_code,o.vehicle_key,o.effective_start_at)=(c.client_code,c.vehicle_key,c.effective_start_at)
    where d.vehicle_link_method='myclicar_contract' and not d.auto_link_disabled
      and d.vehicle_key=c.vehicle_key and d.ludy_driver_code=c.client_code
  ) insert into public.fleet_link_audit(driver_id,action,method,evidence)
    select id,'vehicle_revoke','platform_shift',jsonb_build_object('vehicle_key',vehicle_key,'previous_evidence',vehicle_link_evidence) from displaced;
  delete from public.fleet_motion_checkpoints checkpoint using public.fleet_identities i,public.fleet_drivers d,
    public.fleet_myclicar_contracts c,public.fleet_contract_assignment_overrides o
  where checkpoint.identity_id=i.id and i.driver_id=d.id
    and c.external_id=d.vehicle_link_evidence->>'contract_id' and o.contract_id=c.external_id
    and (o.client_code,o.vehicle_key,o.effective_start_at)=(c.client_code,c.vehicle_key,c.effective_start_at)
    and d.vehicle_link_method='myclicar_contract' and not d.auto_link_disabled
    and d.vehicle_key=c.vehicle_key and d.ludy_driver_code=c.client_code;
  update public.fleet_drivers d set vehicle_key=null,vehicle_link_evidence='{}'
  from public.fleet_myclicar_contracts c,public.fleet_contract_assignment_overrides o
  where c.external_id=d.vehicle_link_evidence->>'contract_id' and o.contract_id=c.external_id
    and (o.client_code,o.vehicle_key,o.effective_start_at)=(c.client_code,c.vehicle_key,c.effective_start_at)
    and d.vehicle_link_method='myclicar_contract' and not d.auto_link_disabled
    and d.vehicle_key=c.vehicle_key and d.ludy_driver_code=c.client_code;
  get diagnostics revoked=row_count;
  return jsonb_build_object('overrides',changed,'revoked',revoked);
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_save_motion_checkpoints(p_states jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if p_states is null or jsonb_typeof(p_states)<>'array' or jsonb_array_length(p_states)>5000 then
    raise exception 'Checkpoints de suivi invalides';
  end if;
  -- The local server owns one serialized motion worker. Replace its snapshot atomically
  -- so an online return, expired assignment or unavailable source cannot leave old progress.
  delete from public.fleet_motion_checkpoints c
  where not exists(select 1 from jsonb_array_elements(p_states) s where (s->>'identity_id')::uuid=c.identity_id);
  insert into public.fleet_motion_checkpoints(identity_id,vehicle_key,source,state,updated_at)
  select (s->>'identity_id')::uuid,s->>'vehicle_key',s->>'source',s->'state',(s->>'updated_at')::timestamptz
  from jsonb_array_elements(p_states) s
  on conflict(identity_id) do update set vehicle_key=excluded.vehicle_key,source=excluded.source,
    state=excluded.state,updated_at=excluded.updated_at;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_source_health()
 RETURNS TABLE(id text, name text, status text, last_success_at timestamp with time zone, last_error text, stale_after_s integer, motion_error boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select * from fleet_read_private.source_health()
$function$;

CREATE OR REPLACE FUNCTION public.fleet_spaced_name_key(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select regexp_replace(lower(coalesce(p_name,'')), '[[:space:]-]+', '', 'g')
$function$;

CREATE OR REPLACE FUNCTION public.fleet_sync_inventory(p_vehicles jsonb, p_agencies jsonb, p_observed_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare item record; matches text[]; target text; agency_ids bigint[]; local_agency bigint; result jsonb;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production marker required';end if;
 if jsonb_typeof(p_vehicles) is distinct from 'array' or jsonb_typeof(p_agencies) is distinct from 'array'
  or jsonb_array_length(p_vehicles)>4000 or jsonb_array_length(p_agencies)>2000 or p_observed_at is null or not isfinite(p_observed_at)
  or p_observed_at>now()+interval '5 seconds' or p_observed_at<now()-interval '300 seconds' then raise exception 'Inventaire complet et récent requis';end if;
 perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
 if p_observed_at<(select last_success_at from public.fleet_inventory_sync where id=1) then raise exception 'Inventaire antérieur au dernier import';end if;
 create temporary table _inventory_vehicles on commit drop as select * from jsonb_populate_recordset(null::public.fleet_myclicar_vehicles,p_vehicles);
 create temporary table _inventory_agencies on commit drop as select * from jsonb_populate_recordset(null::public.fleet_myclicar_agencies,p_agencies);
 if exists(select 1 from _inventory_vehicles where coalesce(external_id,'')='' or length(external_id)>120 or coalesce(reference,'')='' or length(reference)>120
   or plate is null or temporary_plate is null or brand is null or model is null or vin is null or fuel is null or is_blocked is null or archived is null
   or length(plate)>120 or length(temporary_plate)>120 or length(vin)>120 or length(brand)>100 or length(model)>160 or length(fuel)>60
   or status is null or status not in('AVAILABLE','RENTED','RESERVED') or archived is distinct from (deleted_at is not null)
   or deleted_at>p_observed_at+interval '5 seconds' or provider_updated_at>p_observed_at+interval '5 seconds')
  or exists(select 1 from _inventory_agencies where coalesce(external_id,'')='' or length(external_id)>120 or coalesce(code,'')='' or length(code)>120 or coalesce(name,'')='' or length(name)>160)
  or exists(select 1 from _inventory_vehicles group by external_id having count(*)>1)
  or exists(select 1 from _inventory_agencies group by external_id having count(*)>1) then raise exception 'Inventaire invalide ou dupliqué';end if;
 update _inventory_vehicles set vehicle_key=null,agency_id=null,reason='' where external_id is not null;
 update _inventory_agencies set agency_id=null where external_id is not null;
 for item in select * from _inventory_agencies loop
  select a.agency_id into local_agency from public.fleet_myclicar_agencies a where a.external_id=item.external_id;
  if local_agency is null then
   select array_agg(id order by id) into agency_ids from public.agencies
   where (public.fleet_myclicar_agency_label(name)=public.fleet_myclicar_agency_label(item.name)
      or nullif(trim(city),'') is not null and public.fleet_myclicar_agency_label(city)=public.fleet_myclicar_agency_label(item.name))
    and not(public.fleet_myclicar_agency_label(item.name) in('casablanca','marrakech') and nullif(trim(city),'') is not null
      and public.fleet_myclicar_agency_label(city)<>public.fleet_myclicar_agency_label(item.name));
   if cardinality(agency_ids)=1 then local_agency:=agency_ids[1];
   elsif coalesce(cardinality(agency_ids),0)=0 then
    insert into public.agencies(name) values(item.name) on conflict(name) do nothing returning id into local_agency;
    if local_agency is null then select id into local_agency from public.agencies where name=item.name;end if;
   end if;
  end if;
  update _inventory_agencies set agency_id=local_agency where external_id=item.external_id;
 end loop;
 update public.fleet_myclicar_agencies set current=false where current;
 insert into public.fleet_myclicar_agencies(external_id,code,name,agency_id,provider_updated_at,observed_at,current)
 select external_id,code,name,agency_id,provider_updated_at,p_observed_at,true from _inventory_agencies
 on conflict(external_id) do update set code=excluded.code,name=excluded.name,agency_id=excluded.agency_id,provider_updated_at=excluded.provider_updated_at,observed_at=excluded.observed_at,current=true;
 -- An existing provider binding is stable. Otherwise all exact VIN/plate
 -- candidates participate; disagreements remain unresolved.
 for item in select * from _inventory_vehicles loop
  -- An archived provider reference is history, not a competing current car.
  -- It never claims a current local binding or creates an active vehicle.
  if item.archived then
   update _inventory_vehicles set reason='archived_reference' where external_id=item.external_id;continue;
  end if;
  if not item.archived and exists(select 1 from _inventory_vehicles other where other.external_id<>item.external_id and not other.archived and (
   nullif(trim(item.vin),'') is not null and upper(trim(other.vin))=upper(trim(item.vin)) or exists(select 1 from unnest(array[item.plate,item.temporary_plate]) p where public.fleet_myclicar_plate(p)<>'' and public.fleet_myclicar_plate(p) in(public.fleet_myclicar_plate(other.plate),public.fleet_myclicar_plate(other.temporary_plate))))) then
   update _inventory_vehicles set reason='ambiguous_vehicle' where external_id=item.external_id;continue;
  end if;
  select key into target from public.vehicles where myclicar_external_id=item.external_id;
  if target is not null and exists(select 1 from public.vehicles where key=target and nullif(trim(vin),'') is not null and nullif(trim(item.vin),'') is not null and upper(trim(vin))<>upper(trim(item.vin))) then
   update _inventory_vehicles set reason='identifier_conflict' where external_id=item.external_id;continue;
  end if;
  if target is null then
   select array_agg(v.key order by v.key) into matches from public.vehicles v where
    (nullif(trim(item.vin),'') is not null and upper(trim(v.vin))=upper(trim(item.vin))) or exists(
     select 1 from unnest(array[v.key,v.plate]||regexp_split_to_array(coalesce(v.other_plates,''),'[,;]')) alias
     where public.fleet_myclicar_plate(alias)<>'' and public.fleet_myclicar_plate(alias) in(public.fleet_myclicar_plate(item.plate),public.fleet_myclicar_plate(item.temporary_plate)));
   if cardinality(matches)=1 and not exists(
    select 1 from public.vehicles v where v.key=matches[1] and v.myclicar_external_id is not null and v.myclicar_external_id<>item.external_id
     and not exists(select 1 from _inventory_vehicles prior where prior.external_id=v.myclicar_external_id and prior.archived
      and nullif(trim(item.vin),'') is not null and upper(trim(v.vin))=upper(trim(item.vin)) and upper(trim(prior.vin))=upper(trim(item.vin)))
   ) then target:=matches[1];
   elsif coalesce(cardinality(matches),0)>0 then update _inventory_vehicles set reason='ambiguous_vehicle' where external_id=item.external_id;continue;
   elsif item.archived then update _inventory_vehicles set reason='archived_reference' where external_id=item.external_id;continue;
   else
    target:='myclicar:'||item.external_id;
    insert into public.vehicles(key,plate,brand,model,vin,fuel,other_plates,active,myclicar_external_id)
    values(target,coalesce(nullif(item.plate,''),item.temporary_plate),item.brand,item.model,item.vin,item.fuel,nullif(item.temporary_plate,item.plate),'OUI',item.external_id);
   end if;
  end if;
  if target is not null and exists(select 1 from public.vehicles where key=target and nullif(trim(vin),'') is not null and nullif(trim(item.vin),'') is not null and upper(trim(vin))<>upper(trim(item.vin))) then
   update _inventory_vehicles set reason='identifier_conflict' where external_id=item.external_id;continue;
  end if;
  update _inventory_vehicles set vehicle_key=target,reason='matched' where external_id=item.external_id;
 end loop;
 -- Duplicate provider records cannot silently claim the same local car.
 update _inventory_vehicles i set vehicle_key=null,reason='ambiguous_vehicle' where i.vehicle_key is not null and exists(select 1 from _inventory_vehicles o where o.external_id<>i.external_id and o.vehicle_key=i.vehicle_key);
 update public.vehicles v set myclicar_external_id=i.external_id,
  brand=coalesce(nullif(v.brand,''),i.brand),model=coalesce(nullif(v.model,''),i.model),vin=coalesce(nullif(v.vin,''),i.vin),fuel=coalesce(nullif(v.fuel,''),i.fuel),
  other_plates=(select string_agg(distinct alias,',') from unnest(regexp_split_to_array(coalesce(v.other_plates,''),'[,;]')||array[i.plate,i.temporary_plate]) alias where trim(alias)<>'' and public.fleet_myclicar_plate(alias)<>public.fleet_myclicar_plate(v.plate))
 from _inventory_vehicles i where v.key=i.vehicle_key and (v.myclicar_external_id is null or v.myclicar_external_id=i.external_id
  or exists(select 1 from _inventory_vehicles prior where prior.external_id=v.myclicar_external_id and prior.archived
   and nullif(trim(i.vin),'') is not null and upper(trim(v.vin))=upper(trim(i.vin)) and upper(trim(prior.vin))=upper(trim(i.vin))));
 update _inventory_vehicles i set agency_id=v.agency_id from public.vehicles v where v.key=i.vehicle_key;
 insert into public.parc(plate,brand,model,vin,fuel,agency_id)
 select v.plate,v.brand,v.model,v.vin,v.fuel,v.agency_id from public.vehicles v join _inventory_vehicles i on i.vehicle_key=v.key where not i.archived and nullif(v.plate,'') is not null
 on conflict(plate) do nothing;
 update public.fleet_myclicar_vehicles set current=false where current;
 insert into public.fleet_myclicar_vehicles(external_id,reference,plate,temporary_plate,brand,model,vin,fuel,status,is_blocked,archived,deleted_at,provider_updated_at,current,vehicle_key,agency_id,reason,observed_at)
 select external_id,reference,plate,temporary_plate,brand,model,vin,fuel,status,is_blocked,archived,deleted_at,provider_updated_at,true,vehicle_key,agency_id,reason,p_observed_at from _inventory_vehicles
 on conflict(external_id) do update set reference=excluded.reference,plate=excluded.plate,temporary_plate=excluded.temporary_plate,brand=excluded.brand,model=excluded.model,vin=excluded.vin,fuel=excluded.fuel,status=excluded.status,is_blocked=excluded.is_blocked,archived=excluded.archived,deleted_at=excluded.deleted_at,provider_updated_at=excluded.provider_updated_at,current=true,vehicle_key=excluded.vehicle_key,agency_id=excluded.agency_id,reason=excluded.reason,observed_at=excluded.observed_at;
 select jsonb_build_object('vehicles',count(*),'current_vehicles',count(*) filter(where not archived),'archived_vehicles',count(*) filter(where archived),
  'matched_vehicles',count(*) filter(where not archived and vehicle_key is not null),'unmatched_vehicles',count(*) filter(where not archived and vehicle_key is null),'agencies',(select count(*) from _inventory_agencies)) into result from _inventory_vehicles;
 update public.fleet_inventory_sync set status='healthy',last_attempt_at=p_observed_at,last_success_at=p_observed_at,last_error=null,counts=result where id=1;
 drop table _inventory_vehicles;drop table _inventory_agencies;return result;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_sync_myclicar(p_contracts jsonb, p_observed_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare result jsonb;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production marker required';end if;
 if jsonb_typeof(p_contracts) is distinct from 'array' or jsonb_array_length(p_contracts)>10000 or p_observed_at is null or not isfinite(p_observed_at) or p_observed_at>now()+interval '5 seconds' or p_observed_at<now()-interval '300 seconds' then raise exception 'Contrats complets et récents requis';end if;
 perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
 create temporary table _inventory_contract_metadata on commit drop as
 select c.external_id,c.client_code,c.name,c.vehicle_external_id,c.departure_agency_external_id,c.return_agency_external_id,coalesce(c.details_verified,false) details_verified,
  v.vehicle_key,a.agency_id,c.status,c.deleted,c.effective_start_at,c.end_at,
  exists(select 1 from public.fleet_myclicar_vehicles catalog where catalog.external_id=c.vehicle_external_id) catalog_present
 from jsonb_populate_recordset(null::public.fleet_myclicar_contracts,p_contracts) c
 left join public.fleet_myclicar_vehicles v on c.details_verified and v.external_id=c.vehicle_external_id and v.current and not v.archived
  and (public.fleet_myclicar_plate(c.plate)<>'' or public.fleet_myclicar_plate(c.temporary_plate)<>'')
  and (public.fleet_myclicar_plate(c.plate) in(public.fleet_myclicar_plate(v.plate),public.fleet_myclicar_plate(v.temporary_plate)) or public.fleet_myclicar_plate(c.temporary_plate)<>'' and public.fleet_myclicar_plate(c.temporary_plate) in(public.fleet_myclicar_plate(v.plate),public.fleet_myclicar_plate(v.temporary_plate)))
 left join public.fleet_myclicar_agencies a on a.external_id=c.departure_agency_external_id and a.current;
 if exists(select 1 from _inventory_contract_metadata where details_verified and (coalesce(vehicle_external_id,'')='' or length(vehicle_external_id)>120 or length(departure_agency_external_id)>120 or length(return_agency_external_id)>120)) then raise exception 'Références de contrat invalides';end if;
 -- Only complete detail reads establish new exact client references. Existing
 -- names, contacts, agency choices and manual links are never replaced.
 insert into public.drivers(code,name,agency_id,source,status,detected_at)
 select client_code,min(name),case when count(distinct agency_id)=1 then min(agency_id) else null end,'myclicar','ACTIF',p_observed_at
 from _inventory_contract_metadata where details_verified and vehicle_key is not null and nullif(client_code,'') is not null and length(client_code)<=120 and nullif(name,'') is not null
  and status='IN_PROGRESS' and not coalesce(deleted,false) and effective_start_at<=p_observed_at and end_at is null
 group by client_code having count(distinct name)=1 on conflict(code) do nothing;
 update public.vehicles v set agency_id=m.agency_id from (
  select vehicle_key,min(agency_id) agency_id from _inventory_contract_metadata where details_verified and vehicle_key is not null and agency_id is not null and status='IN_PROGRESS' and not coalesce(deleted,false) and end_at is null and effective_start_at<=p_observed_at group by vehicle_key having count(distinct agency_id)=1
 )m where v.key=m.vehicle_key and v.agency_id is null;
 result:=public.fleet_sync_myclicar_reference_base(p_contracts,p_observed_at);
 update public.fleet_myclicar_contracts c set vehicle_external_id=m.vehicle_external_id,departure_agency_external_id=m.departure_agency_external_id,return_agency_external_id=m.return_agency_external_id,details_verified=m.details_verified,agency_id=coalesce((select v.agency_id from public.vehicles v where v.key=c.vehicle_key),m.agency_id),
  eligible=case when m.details_verified and m.catalog_present and (m.vehicle_key is null or m.vehicle_key is distinct from c.vehicle_key) then false
   when m.details_verified and m.agency_id is not null and (select v.agency_id from public.vehicles v where v.key=c.vehicle_key) is distinct from m.agency_id then false else c.eligible end,
  reason=case when m.details_verified and m.catalog_present and (m.vehicle_key is null or m.vehicle_key is distinct from c.vehicle_key) then 'provider_vehicle_mismatch'
   when m.details_verified and m.agency_id is not null and (select v.agency_id from public.vehicles v where v.key=c.vehicle_key) is distinct from m.agency_id then 'provider_agency_mismatch' else c.reason end
 from _inventory_contract_metadata m where c.external_id=m.external_id;
 update public.fleet_myclicar_vehicles i set agency_id=v.agency_id from public.vehicles v where v.key=i.vehicle_key and i.agency_id is distinct from v.agency_id;
 select result||jsonb_build_object('matched_assignments',count(*) filter(where c.eligible),'unmatched_contracts',count(*) filter(where not c.eligible)) into result from public.fleet_myclicar_contracts c join _inventory_contract_metadata m on m.external_id=c.external_id;
 drop table _inventory_contract_metadata;return result;
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_sync_myclicar_reference_base(p_contracts jsonb, p_observed_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare result jsonb;
begin
  if (select value from public.params where key='environment') is distinct from 'production' then
    raise exception 'Production marker required';
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
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_sync_rotation_contracts(p_contracts jsonb, p_observed_at timestamp with time zone, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare receipt jsonb; inserted integer;
begin
  -- The existing transaction validates the complete bounded snapshot first.
  receipt:=public.fleet_sync_rotation_contracts_history_base(p_contracts,p_observed_at,p_from,p_to);
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  if exists(select 1 from jsonb_to_recordset(p_contracts) x(name text,vehicle_external_id text,departure_agency_external_id text,details_verified boolean)
      where length(x.name)>160 or x.name~'[[:cntrl:]]'
        or x.details_verified and (coalesce(x.vehicle_external_id,'')='' or length(x.vehicle_external_id)>120
          or length(x.departure_agency_external_id)>120)) then
    raise exception 'Identité historique MyClicar invalide';
  end if;
  update public.fleet_rotation_contracts c
    set name=coalesce(x.name,''),vehicle_external_id=x.vehicle_external_id,
      departure_agency_external_id=x.departure_agency_external_id,details_verified=coalesce(x.details_verified,false)
  from jsonb_to_recordset(p_contracts) x(external_id text,name text,vehicle_external_id text,departure_agency_external_id text,details_verified boolean)
  where c.external_id=x.external_id and c.observed_at=p_observed_at;

  -- Only the exact provider code and a consistent name from verified returns
  -- may create a missing reference. Existing records and manual choices win.
  -- Historical agency membership is not asserted as the person's current one.
  insert into public.drivers(code,name,agency_id,source,status,detected_at,first_contract,last_contract,n_contracts)
  select c.client_code,min(c.name),null,'myclicar','INACTIF',p_observed_at,
    min(c.effective_start_at),max(c.effective_start_at),count(*)::integer
  from public.fleet_rotation_contracts c
  where c.details_verified and not c.deleted and c.end_at is not null
    and c.effective_start_at is not null and c.end_at>=c.effective_start_at
    and nullif(c.client_code,'') is not null and length(c.client_code)<=120
    and nullif(btrim(c.name),'') is not null
    and exists(select 1 from public.fleet_myclicar_vehicles v where v.external_id=c.vehicle_external_id
      and v.vehicle_key=c.vehicle_key and c.vehicle_key is not null
      and (public.fleet_myclicar_plate(c.plate)<>'' and public.fleet_myclicar_plate(c.plate) in(public.fleet_myclicar_plate(v.plate),public.fleet_myclicar_plate(v.temporary_plate))
        or public.fleet_myclicar_plate(c.temporary_plate)<>'' and public.fleet_myclicar_plate(c.temporary_plate) in(public.fleet_myclicar_plate(v.plate),public.fleet_myclicar_plate(v.temporary_plate))))
    and c.client_code in(select x.client_code from jsonb_to_recordset(p_contracts) x(client_code text))
  group by c.client_code having count(distinct lower(btrim(c.name)))=1
  on conflict(code) do nothing;
  get diagnostics inserted=row_count;
  return receipt||jsonb_build_object('driver_references_created',inserted);
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_sync_rotation_contracts_history_base(p_contracts jsonb, p_observed_at timestamp with time zone, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare saved integer;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production marker required';end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.fleet_vehicle_observation_current(p_source text, p_status text, p_observed_at timestamp with time zone, p_evidence jsonb, p_source_status text, p_success_at timestamp with time zone, p_stale_after_s integer)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare vehicle_at timestamptz; vehicle_ttl integer;
begin
  if p_source_status is distinct from 'healthy'
    or p_status is null or p_status not in ('available','on_trip','to_pickup','on_break')
    or p_observed_at is null or not isfinite(p_observed_at)
    or p_success_at is null or not isfinite(p_success_at)
    or p_stale_after_s is null or p_stale_after_s<=0
    or p_observed_at>now()+interval '5 seconds'
    or p_observed_at<now()-make_interval(secs=>p_stale_after_s)
    or p_success_at>now()+interval '5 seconds'
    or p_success_at<now()-make_interval(secs=>p_stale_after_s)
    or coalesce(p_evidence->>'account_status','') in ('suspended','deactivated') then
    return false;
  end if;

  vehicle_at:=p_observed_at;
  vehicle_ttl:=least(p_stale_after_s,180);
  if p_source='uber' then
    if coalesce(nullif(p_evidence->>'method',''),'visible_dom')<>'visible_dom'
      or (p_evidence->>'vehicle_status' is not null
        and p_evidence->>'vehicle_status' not in ('available','on_trip','to_pickup','on_break')) then
      return false;
    end if;
    if p_evidence->>'vehicle_observed_at' is not null then
      if jsonb_typeof(p_evidence->'vehicle_observed_at') is distinct from 'string' then return false; end if;
      begin
        vehicle_at:=(p_evidence->>'vehicle_observed_at')::timestamptz;
      exception when invalid_datetime_format or datetime_field_overflow then
        return false;
      end;
      vehicle_ttl:=180;
    end if;
  elsif p_source='bolt' then
    if p_evidence->>'method' is distinct from 'official_api'
      or p_evidence->>'vehicle_origin' is distinct from 'bolt_live' then return false; end if;
  else
    return false;
  end if;

  return isfinite(vehicle_at) and vehicle_at<=p_observed_at
    and vehicle_at+make_interval(secs=>vehicle_ttl)>now();
end $function$;

CREATE OR REPLACE FUNCTION public.ludy_desktop_geotab_legacy_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
  declare
    caller_role text := coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claim', true), '')::jsonb ->> 'role',
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    );
  begin
    -- SECURITY DEFINER desktop RPCs run as postgres but retain the verified
    -- authenticated JWT. current_user would therefore identify the wrong actor.
    -- Administrative SQL with no request JWT is unaffected.
    if caller_role is distinct from 'service_role' then
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end if;

    if tg_table_schema = 'public' and tg_table_name = 'live_status' then
      -- Ignore the old collector's positions and snapshot cleanup atomically.
      return null;
    elsif tg_table_schema = 'public' and tg_table_name = 'vehicles' then
      -- Legacy whole-table refreshes must not delete desktop associations or
      -- cascade into desktop snapshots. These legacy deletions are deferred
      -- until ownership is explicitly returned to the legacy collector.
      if tg_op = 'DELETE' then return null; end if;
      if tg_op = 'UPDATE' then
        new.geotab_id := old.geotab_id;
        new.geotab_name := old.geotab_name;
      else
        new.geotab_id := null;
        new.geotab_name := null;
      end if;
      return new;
    end if;

    raise exception 'Unexpected table for the Geotab legacy writer guard';
  end
  $function$;

CREATE OR REPLACE FUNCTION public.ops_can_read_agency(p_agency bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select public.is_admin() or (public.my_role() in ('manager','viewer') and p_agency=any(public.my_agency_ids()))
$function$;

CREATE OR REPLACE FUNCTION public.ops_import_demand(p_import jsonb, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare imported uuid; added integer; agency bigint:=(p_import->>'agency_id')::bigint;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.ops_ingest_events(p_source text, p_rows jsonb, p_at timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.ops_mutate_manual_event(p_action text, p_id uuid, p_expected text, p_row jsonb, p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare old public.ops_events; target public.ops_events; created boolean;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
 if not exists(select 1 from public.profiles where user_id=p_user and role='admin') then raise exception 'Administrator required';end if;
 if p_action is null or p_action not in ('create','update','delete') or p_id is null then raise exception 'Invalid event action';end if;
 if p_action<>'create' and (p_expected is null or p_expected!~'^[a-f0-9]{64}$') then raise exception 'Version required';end if;
 if p_action<>'delete' then
  if jsonb_typeof(p_row) is distinct from 'object' or p_row->>'title' is null or length(trim(p_row->>'title')) not between 1 and 240
   or p_row->>'place' is null or length(trim(p_row->>'place')) not between 1 and 240
   or p_row->>'city' is null or p_row->>'city' not in ('Casablanca','Marrakech')
   or p_row->>'fingerprint' is null or p_row->>'fingerprint'!~'^[a-f0-9]{64}$'
   or p_row->>'starts_at' is null or not isfinite((p_row->>'starts_at')::timestamptz)
   or (p_row->>'ends_at' is not null and (not isfinite((p_row->>'ends_at')::timestamptz) or (p_row->>'ends_at')::timestamptz<(p_row->>'starts_at')::timestamptz))
  then raise exception 'Invalid manual event';end if;
 end if;
 if p_action='create' then
  insert into public.ops_events(id,source_id,external_key,source_url,city,title,place,starts_at,ends_at,source_date_text,time_precision,fingerprint,status,observed_at,reviewed_at,reviewed_by)
  values(p_id,'manual',p_id::text,'',p_row->>'city',trim(p_row->>'title'),trim(p_row->>'place'),(p_row->>'starts_at')::timestamptz,(p_row->>'ends_at')::timestamptz,'Saisie de l’agence','minute',p_row->>'fingerprint','approved',now(),now(),p_user)
  on conflict(id) do nothing returning * into target;
  created:=found;
  if not created then
   select * into old from public.ops_events where id=p_id for update;
   if old.source_id is distinct from 'manual' or old.fingerprint is distinct from p_row->>'fingerprint' then return jsonb_build_object('conflict',true);end if;
   return jsonb_build_object('ok',true,'id',p_id,'duplicate',true);
  end if;
 else
  select * into old from public.ops_events where id=p_id and source_id='manual' for update;
  if not found then return jsonb_build_object('missing',true);end if;
  if old.fingerprint is distinct from p_expected then return jsonb_build_object('conflict',true);end if;
  if p_action='delete' then
   delete from public.ops_event_reviews where event_id=p_id;
   delete from public.ops_events where id=p_id;
   return jsonb_build_object('ok',true,'id',p_id);
  end if;
  update public.ops_events set city=p_row->>'city',title=trim(p_row->>'title'),place=trim(p_row->>'place'),
   starts_at=(p_row->>'starts_at')::timestamptz,ends_at=(p_row->>'ends_at')::timestamptz,
   source_url='',source_date_text='Saisie de l’agence',time_precision='minute',fingerprint=p_row->>'fingerprint',
   status='approved',observed_at=now(),reviewed_at=now(),reviewed_by=p_user where id=p_id returning * into target;
 end if;
 insert into public.ops_event_reviews(event_id,decision,fingerprint,reviewed_by) values(p_id,'approved',target.fingerprint,p_user);
 return jsonb_build_object('ok',true,'id',p_id,'fingerprint',target.fingerprint);
end $function$;

CREATE OR REPLACE FUNCTION public.ops_review_event(p_id uuid, p_fingerprint text, p_decision text, p_user uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare event public.ops_events;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
 if p_decision is null or p_decision not in ('approved','rejected') or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
  or not exists(select 1 from public.profiles where user_id=p_user and role='admin') then raise exception 'Review refused';end if;
 select * into event from public.ops_events where id=p_id for update;
 if not found or event.fingerprint<>p_fingerprint then raise exception 'Event changed: reload before review';end if;
 if p_decision='approved' and event.starts_at is null then raise exception 'Date required before approval';end if;
 update public.ops_events set status=p_decision,reviewed_by=p_user,reviewed_at=now() where id=p_id;
 insert into public.ops_event_reviews(event_id,decision,fingerprint,reviewed_by) values(p_id,p_decision,p_fingerprint,p_user);
 return true;
end $function$;

CREATE OR REPLACE FUNCTION public.ops_set_measured_fuel_reference(p_vehicle text, p_device text, p_reference jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare changed integer; reference_value numeric; distance numeric; litres numeric; start_at timestamptz; end_at timestamptz;
 boundary text; expected_at timestamptz; km_at timestamptz; fuel_at timestamptz;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required'; end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.provider_earnings_amounts_valid(p_amounts jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select jsonb_typeof(p_amounts)='object'
    and p_amounts ?& array['revenue_minor','gross_minor','net_minor','cash_minor','payout_minor',
      'refunds_expenses_minor','adjustments_minor','start_balance_minor','end_balance_minor',
      'fare_minor','tips_minor','tolls_minor','bonus_minor','commission_minor']
    and not exists(select 1 from jsonb_each(p_amounts) e where
      e.key not in ('revenue_minor','gross_minor','net_minor','cash_minor','payout_minor',
        'refunds_expenses_minor','adjustments_minor','start_balance_minor','end_balance_minor',
        'fare_minor','tips_minor','tolls_minor','bonus_minor','commission_minor','reported_net_earnings_minor','taxes_minor')
      or (e.value<>'null'::jsonb and case when jsonb_typeof(e.value)='number'
        and e.value::text ~ '^-?[0-9]+$' then abs((e.value::text)::numeric)>9007199254740991 else true end))
$function$;

CREATE OR REPLACE FUNCTION public.provider_earnings_commit(p_snapshot jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  field_names text[]:=array['revenue_minor','gross_minor','net_minor','cash_minor','payout_minor',
    'refunds_expenses_minor','adjustments_minor','start_balance_minor','end_balance_minor',
    'fare_minor','tips_minor','tolls_minor','bonus_minor','commission_minor','reported_net_earnings_minor','taxes_minor'];
  org uuid; period_from timestamptz; period_to timestamptz; observed timestamptz; currency_code text;
  complete boolean; total_rows integer; entry jsonb; row_number integer; metric_values jsonb;
  candidate_ids uuid[]; target_fleet uuid; target_code text; target_agency bigint; target_method text; reference_agency bigint;
  mapping_state text; mapped_rows jsonb:='[]'::jsonb; mapping_digest text; content_digest text;
  matched integer:=0; all_mapped boolean; old_agencies bigint[]:=array[0]::bigint[]; touched_agency bigint;
  existing public.provider_earnings_snapshots%rowtype; snapshot_uuid uuid; snapshot_version bigint;
begin
  if (select value from public.params where key='environment') is distinct from 'production'
  then raise exception 'Production required'; end if;
  if jsonb_typeof(p_snapshot) is distinct from 'object' or pg_column_size(p_snapshot)>4194304
    or p_snapshot->>'version' is distinct from '1' or p_snapshot->>'source' is distinct from 'uber_fleet_earnings'
    or exists(select 1 from jsonb_object_keys(p_snapshot) k where k not in
      ('version','source','organization_id','source_url','observed_at','provider_period','currency','fleet','fleet_provenance','drivers','coverage','sha256'))
    or coalesce(p_snapshot->>'organization_id','') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    or coalesce(p_snapshot->>'currency','') !~ '^[A-Z]{3}$'
    or coalesce(p_snapshot->>'sha256','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_snapshot->'drivers') is distinct from 'array'
    or jsonb_typeof(p_snapshot->'coverage') is distinct from 'object'
    or jsonb_typeof(p_snapshot->'provider_period') is distinct from 'object'
    or not(p_snapshot->'fleet' ? 'reported_net_earnings_minor')
    or public.provider_earnings_amounts_valid(p_snapshot->'fleet') is distinct from true
    or public.provider_earnings_provenance_valid(p_snapshot->'fleet',p_snapshot->'fleet_provenance') is distinct from true then
    raise exception 'Invalid provider earnings snapshot';
  end if;
  org:=(p_snapshot->>'organization_id')::uuid; currency_code:=p_snapshot->>'currency';
  period_from:=(p_snapshot#>>'{provider_period,start_at}')::timestamptz;
  period_to:=(p_snapshot#>>'{provider_period,end_at}')::timestamptz;
  observed:=(p_snapshot->>'observed_at')::timestamptz;
  if period_from is null or period_to is null or not isfinite(period_from) or not isfinite(period_to)
    or period_to<=period_from or period_to-period_from>interval '367 days' or period_to>now()+interval '8 days'
    or observed is null or not isfinite(observed) or observed>now()+interval '1 minute' or observed<now()-interval '15 minutes'
    or p_snapshot#>>'{provider_period,time_zone}' is distinct from 'Africa/Casablanca'
    or coalesce(p_snapshot#>>'{provider_period,mode}','') not in ('provider','settlement','custom')
    or length(coalesce(p_snapshot#>>'{provider_period,label}','')) not between 1 and 200
    or exists(select 1 from jsonb_object_keys(p_snapshot->'provider_period') k where k not in ('start_at','end_at','time_zone','label','mode'))
    or length(coalesce(p_snapshot->>'source_url',''))>500
    or coalesce(p_snapshot->>'source_url','') !~ ('^https://fleethub[.]uber[.]com/orgs/'||org::text||'/[A-Za-z0-9/_-]+$') then
    raise exception 'Invalid provider earnings period or source';
  end if;
  total_rows:=jsonb_array_length(p_snapshot->'drivers');
  if total_rows>5000 or jsonb_typeof(p_snapshot#>'{coverage,complete}') is distinct from 'boolean'
    or jsonb_typeof(p_snapshot#>'{coverage,filtered}') is distinct from 'boolean'
    or (p_snapshot#>>'{coverage,complete}'='true' and p_snapshot#>>'{coverage,filtered}'='true')
    or (p_snapshot#>>'{coverage,driver_rows_observed}')::integer is distinct from total_rows
    or coalesce(p_snapshot#>>'{coverage,pages}','') !~ '^[0-9]+$'
    or (p_snapshot#>>'{coverage,pages}')::integer not between 1 and 100
    or exists(select 1 from jsonb_object_keys(p_snapshot->'coverage') k where k not in ('complete','filtered','driver_rows_observed','driver_rows_total','pages','reason'))
    or pg_column_size(p_snapshot->'coverage')>2048 then raise exception 'Invalid provider earnings coverage';end if;
  complete:=(p_snapshot#>>'{coverage,complete}')::boolean;
  if (p_snapshot#>>'{coverage,driver_rows_total}')::integer<total_rows
    or (p_snapshot#>>'{coverage,driver_rows_total}')::integer>5000
    or (complete and p_snapshot#>>'{coverage,driver_rows_total}' is not null
      and (p_snapshot#>>'{coverage,driver_rows_total}')::integer<>total_rows)
    or exists(select 1 from jsonb_array_elements(p_snapshot->'drivers') r where r->>'provider_driver_id' is not null
      group by r->>'provider_driver_id' having count(*)>1) then raise exception 'Incomplete or duplicated earnings population';end if;

  -- Match only confirmed provider UUIDs in this organization. The shared lock
  -- serializes with local association changes; names never supply an agency.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fleet-link-assignments',0));
  for entry,row_number in select value,(ordinality-1)::integer from jsonb_array_elements(p_snapshot->'drivers') with ordinality loop
    if jsonb_typeof(entry) is distinct from 'object' or not(entry ? 'reported_net_earnings_minor') or (entry->>'provider_row')::integer is distinct from row_number
      or length(btrim(coalesce(entry->>'driver_name',''))) not between 1 and 200 or entry->>'driver_name' ~ '[[:cntrl:]]'
      or jsonb_typeof(entry->'driver_name_complete') is distinct from 'boolean'
      or (entry->>'provider_driver_id' is not null and entry->>'provider_driver_id' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
      or exists(select 1 from jsonb_object_keys(entry) k where not(k=any(field_names)) and k not in ('provider_row','provider_driver_id','driver_name','driver_name_complete','financial_provenance')) then
      raise exception 'Invalid earnings driver row';
    end if;
    select jsonb_object_agg(key,value) into metric_values from jsonb_each(entry) where key=any(field_names);
    if public.provider_earnings_amounts_valid(metric_values) is distinct from true
      or public.provider_earnings_provenance_valid(metric_values,entry->'financial_provenance') is distinct from true then raise exception 'Invalid earnings driver amounts';end if;
    candidate_ids:=null; target_fleet:=null; target_code:=null; target_agency:=null; target_method:=null; reference_agency:=null;
    if entry->>'provider_driver_id' is not null then
      select array_agg(distinct i.driver_id) into candidate_ids from public.fleet_identities i
        where i.source='uber' and lower(i.organization_id)=org::text and not i.provisional
          and lower(i.external_id)=entry->>'provider_driver_id';
    end if;
    mapping_state:=case when cardinality(candidate_ids)>1 then 'ambiguous' else 'unmatched' end;
    if cardinality(candidate_ids)=1 then
      select d.id,d.ludy_driver_code,d.agency_id,d.link_method,r.agency_id
        into target_fleet,target_code,target_agency,target_method,reference_agency
        from public.fleet_drivers d left join public.drivers r on r.code=d.ludy_driver_code where d.id=candidate_ids[1];
      if target_code is not null and target_agency>0 and reference_agency=target_agency
        and target_method in ('manual','exact_name','name_spacing') then mapping_state:='confirmed';matched:=matched+1;
      else mapping_state:='unassociated';target_code:=null;target_agency:=null;end if;
    end if;
    mapped_rows:=mapped_rows||jsonb_build_array(jsonb_build_object(
      'provider_row',row_number,'provider_driver_id',entry->'provider_driver_id',
      'driver_name',entry->>'driver_name','driver_name_complete',(entry->>'driver_name_complete')::boolean,
      'fleet_driver_id',target_fleet,'driver_code',target_code,'agency_id',target_agency,
      'mapping_status',mapping_state,'amounts',metric_values,'financial_provenance',entry->'financial_provenance'));
  end loop;
  all_mapped:=matched=total_rows;
  mapping_digest:=md5(mapped_rows::text);
  content_digest:=md5((p_snapshot-'observed_at'-'sha256')::text);
  select * into existing from public.provider_earnings_snapshots
    where source='uber' and organization_id=org and period_start=period_from and period_end=period_to and currency=currency_code for update;
  if found then
    if observed<existing.observed_at or (not complete and (existing.coverage->>'complete')::boolean) then
      return jsonb_build_object('snapshot_id',existing.id,'revision',existing.revision,'duplicate',false,'ignored',true,
        'reason',case when observed<existing.observed_at then 'stale_observation' else 'complete_snapshot_preserved' end,
        'rows',(existing.coverage->>'driver_rows_observed')::integer,'coverage_complete',(existing.coverage->>'complete')::boolean,
        'mapping_complete',existing.mapping_complete);
    end if;
    if existing.content_fingerprint=content_digest and existing.mapping_fingerprint=mapping_digest and existing.observed_at=observed then
      return jsonb_build_object('snapshot_id',existing.id,'revision',existing.revision,'duplicate',true,'ignored',false,
        'rows',total_rows,'matched',matched,'unmatched',total_rows-matched,'coverage_complete',complete,'mapping_complete',all_mapped);
    end if;
    if existing.observed_at=observed and existing.content_fingerprint<>content_digest then raise exception 'Conflicting earnings observation';end if;
    select array_agg(distinct coalesce(agency_id,0)) into old_agencies from public.provider_earnings_rows where snapshot_id=existing.id;
  end if;
  insert into public.provider_earnings_snapshots(source,organization_id,period_start,period_end,time_zone,period_label,period_mode,
    currency,observed_at,sha256,content_fingerprint,mapping_fingerprint,coverage,mapping_complete,fleet_amounts,financial_provenance,source_url)
  values('uber',org,period_from,period_to,'Africa/Casablanca',p_snapshot#>>'{provider_period,label}',p_snapshot#>>'{provider_period,mode}',
    currency_code,observed,p_snapshot->>'sha256',content_digest,mapping_digest,p_snapshot->'coverage',all_mapped,p_snapshot->'fleet',p_snapshot->'fleet_provenance',p_snapshot->>'source_url')
  on conflict(source,organization_id,period_start,period_end,currency) do update set
    period_label=excluded.period_label,period_mode=excluded.period_mode,observed_at=excluded.observed_at,received_at=now(),
    revision=public.provider_earnings_snapshots.revision+1,sha256=excluded.sha256,content_fingerprint=excluded.content_fingerprint,
    mapping_fingerprint=excluded.mapping_fingerprint,coverage=excluded.coverage,mapping_complete=excluded.mapping_complete,
    fleet_amounts=excluded.fleet_amounts,financial_provenance=excluded.financial_provenance,source_url=excluded.source_url
  returning id,revision into snapshot_uuid,snapshot_version;
  -- Replace rows only inside this exact snapshot window. Other periods and all
  -- historical CSV/cash tables remain untouched. Partial data cannot erase a full capture.
  delete from public.provider_earnings_rows where snapshot_id=snapshot_uuid;
  insert into public.provider_earnings_rows(snapshot_id,provider_row,source,organization_id,period_start,period_end,time_zone,currency,
    observed_at,snapshot_revision,coverage_complete,mapping_complete,agency_rows_total,driver_rows_total,
    provider_driver_id,driver_name,driver_name_complete,fleet_driver_id,driver_code,agency_id,mapping_status,amounts,financial_provenance)
  select snapshot_uuid,r.provider_row,'uber',org,period_from,period_to,'Africa/Casablanca',currency_code,
    observed,snapshot_version,complete,all_mapped,(count(*) over(partition by r.agency_id))::integer,
    (count(*) over(partition by r.driver_code))::integer,r.provider_driver_id,r.driver_name,r.driver_name_complete,
    r.fleet_driver_id,r.driver_code,r.agency_id,r.mapping_status,r.amounts,r.financial_provenance
  from jsonb_to_recordset(mapped_rows) as r(provider_row integer,provider_driver_id uuid,driver_name text,driver_name_complete boolean,
    fleet_driver_id uuid,driver_code text,agency_id bigint,mapping_status text,amounts jsonb,financial_provenance jsonb);
  -- Only minimal refresh markers are published. Include old and new agencies,
  -- sorted, and the admin marker for the independent fleet total.
  for touched_agency in select distinct scope from (
    select unnest(coalesce(old_agencies,array[]::bigint[])) scope union select 0
    union select coalesce((r->>'agency_id')::bigint,0) from jsonb_array_elements(mapped_rows) r
  ) scopes order by scope loop
    insert into public.revenue_refresh(agency_id,version,touched_at) values(touched_agency,1,clock_timestamp())
      on conflict(agency_id) do update set version=public.revenue_refresh.version+1,touched_at=clock_timestamp();
  end loop;
  return jsonb_build_object('snapshot_id',snapshot_uuid,'revision',snapshot_version,'duplicate',false,'ignored',false,
    'rows',total_rows,'matched',matched,'unmatched',total_rows-matched,'coverage_complete',complete,'mapping_complete',all_mapped);
end $function$;

CREATE OR REPLACE FUNCTION public.provider_earnings_provenance_valid(a jsonb, p jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare e jsonb; fields text[]:=array[]::text[]; name text; n numeric; s numeric:=0; gross numeric:=0; k text;
begin
 if p is null or p='null'::jsonb then return true;end if;
 if jsonb_typeof(p)<>'object' or p->'version' is distinct from '1'::jsonb or pg_column_size(p)>8192 then return false;end if;
 if p->>'status'='unavailable' then
  return coalesce(p->>'reason'=any(array['missing_breakdown','incomplete_breakdown','unknown_component','invalid_component','conflicting_component','total_mismatch','amount_overflow','conflicting_reported_amount'])
   and not exists(select 1 from jsonb_object_keys(p) key where key not in ('version','status','reason')),false);
 end if;
 if p->>'status' is distinct from 'verified' or p->>'basis' is distinct from 'visible_total_earnings_breakdown'
  or p->>'gross_definition' is distinct from 'before_uber_fees_and_provider_taxes'
  or p->>'net_definition' is distinct from 'after_uber_fees_before_provider_taxes'
  or p->>'formula' is distinct from 'fare_plus_tips_plus_bonus' or p->>'reconciliation' is distinct from 'exact'
  or jsonb_typeof(p->'entries') is distinct from 'array'
  or exists(select 1 from jsonb_object_keys(p) key where key not in ('version','status','basis','gross_definition','net_definition','formula','reconciliation','total_minor','entries'))
 then return false;end if;
 if jsonb_array_length(p->'entries') not between 1 and 30 then return false;end if;
 for e in select value from jsonb_array_elements(p->'entries') loop
  name:=e->>'field';
  if jsonb_typeof(e)<>'object' or name is null or name<>all(array['fare','commission','taxes','tips','bonus']) or name=any(fields)
   or exists(select 1 from jsonb_object_keys(e) key where key not in ('field','label','minor'))
   or (name='fare' and e->>'label' is distinct from 'Fare')
   or (name='commission' and e->>'label' is distinct from 'Service Fee')
   or (name='taxes' and e->>'label' is distinct from 'Taxes')
   or (name='tips' and coalesce(e->>'label','') not in ('Tip','Tips'))
   or (name='bonus' and coalesce(e->>'label','') not in ('Promotion','Promotions'))
   or jsonb_typeof(e->'minor') is distinct from 'number' or coalesce(e->>'minor','') !~ '^-?[0-9]+$'
  then return false;end if;
  n:=(e->>'minor')::numeric;if abs(n)>9007199254740991 or a->(name||'_minor') is distinct from e->'minor' then return false;end if;
  fields:=array_append(fields,name);s:=s+n;if name in ('fare','tips','bonus') then gross:=gross+n;end if;
 end loop;
 if not('fare'=any(fields)) or abs(s)>9007199254740991 or abs(gross)>9007199254740991 then return false;end if;
 foreach k in array array['fare','commission','taxes','tips','bonus'] loop
  if not(k=any(fields)) and a->(k||'_minor') is distinct from '0'::jsonb then return false;end if;
 end loop;
 return coalesce(a->'revenue_minor'=to_jsonb(s) and a->'net_minor'=to_jsonb(gross+coalesce((a->>'commission_minor')::numeric,0)) and a->'gross_minor'=to_jsonb(gross) and p->'total_minor'=to_jsonb(s),false);
exception when others then return false;
end $function$;

CREATE OR REPLACE FUNCTION public.provider_earnings_reconcile(p_snapshot uuid, p_revision bigint, p_row integer, p_driver_code text, p_agency_id bigint, p_evidence_kind text, p_evidence_reference text, p_confirm boolean DEFAULT false, p_assign_missing_agency boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor uuid:=auth.uid(); snapshot public.provider_earnings_snapshots; entry public.provider_earnings_rows;
 reference public.drivers; identity_ids uuid[]; source_driver uuid; canonical uuid; destination uuid;
 old_agency bigint; audit_id uuid; decision text; evidence jsonb; org uuid;
 retained_vehicle text; source_vehicle text;
begin
 if (select value from public.params where key='environment') is distinct from 'production' or actor is null
 then raise exception 'Administrateur local requis' using errcode='42501';end if;
 -- Revalidate the role inside the write transaction. A concurrent role change
 -- waits for this decision; the HTTP/UI role is never trusted as authorization.
 perform 1 from public.profiles where user_id=actor and role='admin' for share;
 if not found then raise exception 'Administrateur local requis' using errcode='42501';end if;
 if p_revision is null or p_revision<1 or p_row is null or p_row not between 0 and 4999
  or length(btrim(coalesce(p_driver_code,''))) not between 1 and 120 or p_agency_id is null or p_agency_id<=0
  or p_evidence_kind is null or p_evidence_kind not in('provider_profile','provider_export','signed_record')
  or length(btrim(coalesce(p_evidence_reference,''))) not between 10 and 1000 or p_evidence_reference~'[[:cntrl:]]'
  or p_confirm is distinct from true or p_assign_missing_agency is null then raise exception 'Preuve et sélection explicites requises' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fleet-link-assignments',0));
 select organization_id into org from public.uber_report_settings where id=1 for share;
 select * into snapshot from public.provider_earnings_snapshots where id=p_snapshot and organization_id=org for update;
 if not found or snapshot.revision<>p_revision then raise exception 'Le relevé a changé. Relisez la ligne avant de confirmer.' using errcode='40001';end if;
 select * into entry from public.provider_earnings_rows where snapshot_id=p_snapshot and provider_row=p_row and snapshot_revision=p_revision for update;
 if not found or entry.mapping_status='confirmed' then raise exception 'Cette ligne doit être relue.' using errcode='40001';end if;
 select * into reference from public.drivers where code=p_driver_code for update;
 if not found then raise exception 'Fiche Ludy absente' using errcode='22023';end if;
 perform 1 from public.agencies where id=p_agency_id for share;
 if not found or (reference.agency_id is not null and reference.agency_id<>p_agency_id)
 then raise exception 'Agence incompatible avec la fiche Ludy' using errcode='22023';end if;
 old_agency:=reference.agency_id;
 if p_confirm and entry.provider_driver_id is null then raise exception 'UUID fournisseur non prouvé : fournissez une preuve fournisseur avant le rapprochement' using errcode='22023';end if;
 if p_confirm and old_agency is null and not p_assign_missing_agency
 then raise exception 'Confirmez explicitement l’agence de cette fiche sans agence' using errcode='22023';end if;
 decision:='confirmed_identity';
 evidence:=jsonb_build_object('method','financial_manual_review','actor',actor,'snapshot_id',p_snapshot,'snapshot_revision',p_revision,
  'provider_row',p_row,'organization_id',org,'provider_driver_id',entry.provider_driver_id,'ludy_driver_code',p_driver_code,
  'agency_id',p_agency_id,'evidence_kind',p_evidence_kind,'evidence_reference',btrim(p_evidence_reference));
 if p_confirm then
  lock table public.fleet_identities in share row exclusive mode;
  select array_agg(distinct i.driver_id) into identity_ids from public.fleet_identities i
   where i.source='uber' and lower(i.organization_id)=org::text and lower(i.external_id)=entry.provider_driver_id::text;
  if cardinality(identity_ids)>1 then raise exception 'UUID déjà associé à plusieurs profils : revue requise' using errcode='23505';end if;
  source_driver:=identity_ids[1];
  select id into destination from public.fleet_drivers where ludy_driver_code=p_driver_code for update;
  if source_driver is not null and exists(select 1 from public.fleet_drivers where id=source_driver and ludy_driver_code is not null and ludy_driver_code<>p_driver_code)
  then raise exception 'Cet UUID possède déjà une autre fiche Ludy' using errcode='23505';end if;
  if exists(select 1 from public.fleet_drivers d where d.id in(destination,source_driver)
    and d.agency_id is not null and d.agency_id<>p_agency_id)
  then raise exception 'Agence contradictoire sur un profil existant : revue requise' using errcode='23505';end if;
  if exists(select 1 from public.fleet_identities i where i.driver_id in(destination,source_driver)
    and i.source='uber' and lower(i.organization_id)=org::text and i.external_id is not null and lower(i.external_id)<>entry.provider_driver_id::text)
  then raise exception 'La fiche choisie possède déjà un autre UUID Uber pour cette flotte' using errcode='23505';end if;
  if old_agency is null then update public.drivers set agency_id=p_agency_id where code=p_driver_code;end if;
  if source_driver is null then
   source_driver:=destination;
   if source_driver is null then insert into public.fleet_drivers(name) values(reference.name) returning id into source_driver;end if;
   insert into public.fleet_identities(driver_id,source,source_key,external_id,organization_id,provisional)
    values(source_driver,'uber',org::text||':'||entry.provider_driver_id::text,entry.provider_driver_id::text,org::text,false);
  end if;
  select vehicle_key into retained_vehicle from public.fleet_drivers where id=coalesce(destination,source_driver) for update;
  select vehicle_key into source_vehicle from public.fleet_drivers where id=source_driver for update;
  if destination is not null and destination<>source_driver and source_vehicle is not null
   and source_vehicle is distinct from retained_vehicle then
   raise exception 'Les profils portent des véhicules différents : revue des associations existantes requise' using errcode='23505';
  end if;
  if destination is not null and destination<>source_driver and exists(
   select 1 from public.fleet_drivers a join public.fleet_drivers b on b.id=destination where a.id=source_driver
    and (a.auto_link_disabled is distinct from b.auto_link_disabled or a.vehicle_link_method is distinct from b.vehicle_link_method)) then
   raise exception 'Les profils ont des modes de véhicule différents : revue des associations existantes requise' using errcode='23505';
  end if;
  -- Reuse the historical-reference preserving merge, without the wrapper that
  -- changes manual/automatic vehicle mode. No vehicle is selected by this RPC.
  canonical:=public.fleet_link_driver_base(source_driver,p_driver_code,retained_vehicle,p_agency_id);
  update public.fleet_drivers set link_method='manual',link_evidence=evidence where id=canonical;
  update public.fleet_identities set provisional=false where driver_id=canonical and source='uber'
   and lower(organization_id)=org::text and lower(external_id)=entry.provider_driver_id::text;
  insert into public.fleet_link_audit(driver_id,action,method,evidence) values(canonical,'associate','manual',evidence) returning id into audit_id;
 end if;
 return jsonb_build_object('version',1,'audit_id',audit_id,'decision',decision,'financial_history_unchanged',true,
  'awaiting_provider_uuid',entry.provider_driver_id is null,'awaiting_next_collection',p_confirm,
  'agency_assigned',p_confirm and old_agency is null);
end $function$;

CREATE OR REPLACE FUNCTION public.provider_earnings_reconciliation_queue(p_snapshot uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare target public.provider_earnings_snapshots; org uuid;
begin
 if (select value from public.params where key='environment') is distinct from 'production'
  or auth.uid() is null or public.is_admin() is distinct from true then raise exception 'Administrateur local requis' using errcode='42501';end if;
 select organization_id into org from public.uber_report_settings where id=1;
 select * into target from public.provider_earnings_snapshots s where s.organization_id=org
  and (p_snapshot is null or s.id=p_snapshot)
  order by (s.period_start<=now() and s.period_end>now()) desc,s.period_start desc,s.observed_at desc limit 1;
 if target.id is null then return jsonb_build_object('version',1,'snapshot',null,'rows','[]'::jsonb,'drivers','[]'::jsonb,'agencies','[]'::jsonb);end if;
 return jsonb_build_object('version',1,'snapshot',jsonb_build_object('id',target.id,'revision',target.revision,
   'period_start',target.period_start,'period_end',target.period_end,'observed_at',target.observed_at,'total_rows',target.coverage->'driver_rows_observed'),
  'rows',coalesce((select jsonb_agg(jsonb_build_object('provider_row',r.provider_row,'provider_driver_id',r.provider_driver_id,
   'driver_name',r.driver_name,'driver_name_complete',r.driver_name_complete,'mapping_status',r.mapping_status,
   'latest_decision',(select jsonb_build_object('decision','confirmed_identity','created_at',a.at,
    'driver_code',a.evidence->>'ludy_driver_code','agency_id',a.evidence->'agency_id',
    'evidence_kind',a.evidence->>'evidence_kind','evidence_reference',a.evidence->>'evidence_reference')
    from public.fleet_link_audit a where a.evidence->>'method'='financial_manual_review'
     and a.evidence->>'organization_id'=r.organization_id::text
     and a.evidence->>'provider_driver_id'=r.provider_driver_id::text
    order by a.at desc,a.id desc limit 1)) order by r.provider_row)
   from public.provider_earnings_rows r where r.snapshot_id=target.id and r.mapping_status<>'confirmed'),'[]'::jsonb),
  'drivers',coalesce((select jsonb_agg(jsonb_build_object('code',d.code,'name',d.name,'agency_id',d.agency_id) order by d.name,d.code) from public.drivers d),'[]'::jsonb),
  'agencies',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) order by a.name,a.id) from public.agencies a),'[]'::jsonb));
end $function$;

CREATE OR REPLACE FUNCTION public.provider_earnings_select_windows(p_start timestamp with time zone, p_end timestamp with time zone, p_organization_ids uuid[], p_agency_id bigint DEFAULT NULL::bigint, p_driver_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  caller_role text:=public.my_role();
  fleet_scope boolean;
  selected_ids uuid[];
begin
  if auth.uid() is null or caller_role is null or caller_role not in ('admin','manager')
  then raise exception 'Financial access required' using errcode='42501'; end if;
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end)
    or p_end<=p_start or p_end-p_start>interval '367 days'
    or p_organization_ids is null or cardinality(p_organization_ids)>100
    or array_position(p_organization_ids,null) is not null
    or (p_agency_id is not null and p_agency_id<=0)
    or (p_driver_code is not null and (length(p_driver_code) not between 1 and 100
      or btrim(p_driver_code)='' or p_driver_code ~ '[[:cntrl:]]'))
  then raise exception 'Invalid Earnings selection' using errcode='22023'; end if;
  if caller_role='manager' and p_agency_id is not null
    and not(p_agency_id=any(coalesce(public.my_agency_ids(),array[]::bigint[])))
  then raise exception 'Financial agency inaccessible' using errcode='42501'; end if;
  fleet_scope:=caller_role='admin' and p_agency_id is null and p_driver_code is null;

  with visible as materialized (
    -- Only an unfiltered administrator uses fleet metadata, including an empty
    -- fleet with zero driver rows. No header is used for a manager/scoped read.
    select s.id as snapshot_id,s.organization_id,s.currency,s.period_start,s.period_end,
      s.observed_at,s.revision,coalesce(s.coverage->'complete'='true'::jsonb,false) as complete
    from public.provider_earnings_snapshots s
    where fleet_scope and s.source='uber' and s.period_start<p_end and s.period_end>p_start
      and (cardinality(p_organization_ids)=0 or s.organization_id=any(p_organization_ids))
    union all
    select r.snapshot_id,r.organization_id,r.currency,r.period_start,r.period_end,
      r.observed_at,r.snapshot_revision as revision,
      bool_and(r.coverage_complete and r.mapping_complete) as complete
    from public.provider_earnings_rows r
    where not fleet_scope and r.source='uber' and r.period_start<p_end and r.period_end>p_start
      and (cardinality(p_organization_ids)=0 or r.organization_id=any(p_organization_ids))
      and (p_agency_id is null or r.agency_id=p_agency_id)
      and (p_driver_code is null or r.driver_code=p_driver_code)
    group by r.snapshot_id,r.organization_id,r.currency,r.period_start,r.period_end,r.observed_at,r.snapshot_revision
  ), ranked as (
    select v.*,row_number() over(partition by organization_id,currency
      order by complete desc,observed_at desc,revision desc,snapshot_id) as preferred
    from visible v
  ), bounded as (
    -- An exact requested window is retained even if it is old/partial. The
    -- other choice is the newest complete overlap, or newest partial if none
    -- is complete. The caller still validates row counts, revisions and money.
    select distinct snapshot_id from ranked
    where (period_start=p_start and period_end=p_end) or preferred=1
    order by snapshot_id limit 101
  )
  select coalesce(array_agg(snapshot_id order by snapshot_id),array[]::uuid[])
  into selected_ids from bounded;
  if cardinality(selected_ids)>100
  then raise exception 'Too many Earnings scopes; narrow the selection' using errcode='54000'; end if;
  return jsonb_build_object('version',1,'snapshot_ids',to_jsonb(selected_ids),'selection_complete',true);
end $function$;

CREATE OR REPLACE FUNCTION public.revenue_refresh_after_statement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare affected_agencies bigint[]; affected_agency bigint;
begin
  if tg_table_schema <> 'public' or tg_table_name not in ('uber_payments', 'bolt_sessions', 'cash_moves')
    or tg_op not in ('INSERT', 'UPDATE', 'DELETE') then
    raise exception 'Financial statement trigger required';
  end if;
  -- Transition tables are statement-local PostgreSQL relations, not public data
  -- resolved through a caller-controlled search path. One bump per agency per
  -- statement avoids serializing every row of a large CSV import on the marker.
  if tg_op='INSERT' then
    select array_agg(s.agency_id order by s.agency_id) into affected_agencies
      from (select distinct coalesce(r.agency_id,0) agency_id from new_revenue_rows r) s;
  elsif tg_op='DELETE' then
    select array_agg(s.agency_id order by s.agency_id) into affected_agencies
      from (select distinct coalesce(r.agency_id,0) agency_id from old_revenue_rows r) s;
  else
    select array_agg(s.agency_id order by s.agency_id) into affected_agencies
      from (select coalesce(r.agency_id,0) agency_id from old_revenue_rows r
        union select coalesce(r.agency_id,0) agency_id from new_revenue_rows r) s;
  end if;
  -- Sorting OLD/NEW scopes gives concurrent agency transfers the same lock order.
  foreach affected_agency in array coalesce(affected_agencies,array[]::bigint[]) loop
    insert into public.revenue_refresh(agency_id,version,touched_at)
      values(affected_agency,1,pg_catalog.clock_timestamp())
    on conflict(agency_id) do update
      set version=public.revenue_refresh.version+1,touched_at=pg_catalog.clock_timestamp();
  end loop;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
  tbl name;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
        EXECUTE format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.telemetry_archive_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin raise exception 'Telemetry archive is append-only';end $function$;

CREATE OR REPLACE FUNCTION public.telemetry_archive_ingest(p_events jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 e jsonb;o jsonb;provenance jsonb;event_source text;event_id text;device text;vehicle text;
 observed timestamptz;collected timestamptz;agency bigint;bound_device text;
 semantic_hash text;found_row public.telemetry_observations%rowtype;next_version integer;inserted_id uuid;
 inserted_count integer:=0;duplicate_count integer:=0;conflict_count integer:=0;receipts jsonb:='[]'::jsonb;
 allowed text[];number_value numeric;raw_value numeric;
begin
 if (select value from public.params where key='environment') is distinct from 'production'
 then raise exception 'Production required';end if;
 if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) not between 1 and 500
  or pg_column_size(p_events)>2097152 then raise exception 'Invalid telemetry batch';end if;
 -- Sorting keeps event advisory locks and vehicle row locks in a stable order.
 for e in select value from jsonb_array_elements(p_events)
  order by value->>'vehicle_key',value->>'source',value->>'device_id',value->>'source_event_id',value::text loop
  if jsonb_typeof(e) is distinct from 'object' or not(e ?& array['source','source_event_id','device_id','vehicle_key','observed_at','collected_at','observation','origin'])
   or exists(select 1 from jsonb_object_keys(e) k where k not in ('source','source_event_id','device_id','vehicle_key','observed_at','collected_at','observation','origin'))
   or coalesce(e->>'source','') not in ('geotab','texat') or coalesce(e->>'source_event_id','') !~ '^[a-f0-9]{64}$'
   or jsonb_typeof(e->'device_id') is distinct from 'string' or length(btrim(e->>'device_id')) not between 1 and 200
   or jsonb_typeof(e->'vehicle_key') is distinct from 'string' or length(btrim(e->>'vehicle_key')) not between 1 and 200
   or e->>'device_id' ~ '[[:cntrl:]]' or e->>'vehicle_key' ~ '[[:cntrl:]]'
   or jsonb_typeof(e->'observation') is distinct from 'object' or pg_column_size(e->'observation')>8192
   or jsonb_typeof(e->'origin') is distinct from 'object' or pg_column_size(e->'origin')>1024
   or coalesce(e->>'observed_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$'
   or coalesce(e->>'collected_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$' then raise exception 'Invalid telemetry event';end if;
  event_source:=e->>'source';event_id:=e->>'source_event_id';device:=e->>'device_id';vehicle:=e->>'vehicle_key';
  -- No invented Texat endpoint or device mapping: adding that connector needs a
  -- separately reviewed confirmed binding, not a client-supplied vehicle key.
  if event_source<>'geotab' then raise exception 'Texat device binding is not configured';end if;
  observed:=(e->>'observed_at')::timestamptz;collected:=(e->>'collected_at')::timestamptz;
  if observed is null or collected is null or not isfinite(observed) or not isfinite(collected)
   or observed<'2000-01-01Z'::timestamptz or observed>collected+interval '1 minute'
   or collected>clock_timestamp()+interval '1 minute' then raise exception 'Invalid telemetry times';end if;
  o:=e->'observation';provenance:=e->'origin';
  if not(o ?& array['id','vehicleKey','source','sourceId','kind','quality','observedAt','receivedAt','channel'])
   or o->>'id' is distinct from event_id or o->>'vehicleKey' is distinct from vehicle
   or o->>'source' is distinct from event_source or o->>'sourceId' is distinct from device
   or (o->>'observedAt')::timestamptz is distinct from observed or (o->>'receivedAt')::timestamptz is distinct from collected
   or coalesce(o->>'quality','') not in ('good','degraded','unknown','invalid')
   or coalesce(o->>'kind','') not in ('gps','counter') then raise exception 'Incoherent telemetry observation';end if;
  allowed:=array['id','vehicleKey','source','sourceId','kind','quality','observedAt','receivedAt','channel'];
  if not(provenance ?& array['field','unit','raw_value','sample_at'])
   or exists(select 1 from jsonb_object_keys(provenance) k where k not in ('field','unit','raw_value','sample_at'))
   or (provenance->>'sample_at')::timestamptz is distinct from observed then raise exception 'Invalid telemetry provenance';end if;
  if o->>'kind'='gps' then
   allowed:=allowed||array['latitude','longitude','accuracyM'];
   if not(o ?& array['latitude','longitude','accuracyM']) or o->>'channel' is distinct from 'gps'
    or jsonb_typeof(o->'latitude') is distinct from 'number' or abs((o->>'latitude')::numeric)>90
    or jsonb_typeof(o->'longitude') is distinct from 'number' or abs((o->>'longitude')::numeric)>180
    or (o->'accuracyM'<>'null'::jsonb and (jsonb_typeof(o->'accuracyM') is distinct from 'number' or (o->>'accuracyM')::numeric not between 0 and 1000000000))
    or provenance->>'field' is distinct from 'position' or provenance->>'unit' is distinct from 'deg'
    or provenance->'raw_value' is distinct from 'null'::jsonb then raise exception 'Invalid telemetry GPS';end if;
  else
   allowed:=allowed||array['metric','unit','value','counterId','counterEpoch','counterMeaning'];
   if not(o ?& array['metric','unit','value','counterId','counterEpoch','counterMeaning'])
    or jsonb_typeof(o->'value') is distinct from 'number' or jsonb_typeof(provenance->'raw_value') is distinct from 'number'
    or (o->'counterEpoch'<>'null'::jsonb and (jsonb_typeof(o->'counterEpoch') is distinct from 'string' or length(btrim(o->>'counterEpoch')) not between 1 and 200 or o->>'counterEpoch' ~ '[[:cntrl:]]')) then raise exception 'Invalid telemetry counter';end if;
   number_value:=(o->>'value')::numeric;raw_value:=(provenance->>'raw_value')::numeric;
   if number_value not between 0 and 9007199254740991 or raw_value not between 0 and 9007199254740991 then raise exception 'Invalid telemetry counter value';end if;
   if o->>'metric'='distance_km' then
    if o->>'channel' is distinct from 'distance' or o->>'unit' is distinct from 'km' or o->>'counterMeaning' is distinct from 'odometer'
     or o->>'counterId' is distinct from 'DiagnosticOdometerId' or provenance->>'field' is distinct from 'odometer_m' or provenance->>'unit' is distinct from 'm'
     or abs(number_value*1000-raw_value)>greatest(0.000001,abs(raw_value)*0.000000000001) then raise exception 'Invalid telemetry distance unit';end if;
   elsif o->>'metric'='fuel_l' then
    if o->>'channel' is distinct from 'fuel' or o->>'unit' is distinct from 'L' or o->>'counterMeaning' is distinct from 'fuel_consumed'
     or o->>'counterId' is distinct from 'DiagnosticDeviceTotalFuelId' or provenance->>'field' is distinct from 'total_fuel_l' or provenance->>'unit' is distinct from 'L'
     or number_value<>raw_value then raise exception 'Invalid telemetry consumed fuel unit';end if;
   else raise exception 'Unsupported telemetry metric';end if;
  end if;
  if exists(select 1 from jsonb_object_keys(o) k where not(k=any(allowed))) then raise exception 'Unexpected telemetry observation field';end if;
  select v.geotab_id,v.agency_id into bound_device,agency from public.vehicles v where v.key=vehicle for share;
  if not found or bound_device is distinct from device or (select count(*) from public.vehicles where geotab_id=device)<>1 then
   raise exception 'Telemetry device binding is not unique and confirmed';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(jsonb_build_array(event_source,device,event_id)::text,0));
  if exists(select 1 from public.telemetry_observations t where t.source=event_source and t.device_id=device and t.source_event_id=event_id and t.vehicle_key<>vehicle) then
   raise exception 'Historical telemetry event cannot be rebound';end if;
  semantic_hash:=encode(sha256(convert_to(jsonb_build_object('observation',o-'receivedAt','origin',provenance)::text,'UTF8')),'hex');
  select * into found_row from public.telemetry_observations t where t.source=event_source and t.device_id=device and t.source_event_id=event_id and t.fingerprint=semantic_hash;
  if found then
   duplicate_count:=duplicate_count+1;
   receipts:=receipts||jsonb_build_array(jsonb_build_object('id',found_row.id,'source_event_id',event_id,'version',found_row.version,'fingerprint',semantic_hash,'duplicate',true));
   continue;
  end if;
  select coalesce(max(t.version),0)+1 into next_version from public.telemetry_observations t where t.source=event_source and t.device_id=device and t.source_event_id=event_id;
  insert into public.telemetry_observations(source,source_event_id,device_id,vehicle_key,observed_at,collected_at,version,fingerprint,observation,origin,agency_id_at_receipt,mapping_basis)
   values(event_source,event_id,device,vehicle,observed,collected,next_version,semantic_hash,o,provenance,agency,'current_at_receipt') returning id into inserted_id;
  inserted_count:=inserted_count+1;if next_version>1 then conflict_count:=conflict_count+1;end if;
  receipts:=receipts||jsonb_build_array(jsonb_build_object('id',inserted_id,'source_event_id',event_id,'version',next_version,'fingerprint',semantic_hash,'duplicate',false));
 end loop;
 return jsonb_build_object('received',jsonb_array_length(p_events),'inserted',inserted_count,'duplicates',duplicate_count,'conflicts',conflict_count,'rows',receipts);
end $function$;

CREATE OR REPLACE FUNCTION public.uber_driver_report_commit(p_org uuid, p_revision bigint, p_hash text, p_type text, p_batches jsonb, p_rows jsonb, p_counts jsonb, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare config public.uber_report_settings;promoted integer;result jsonb;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
 select * into config from public.uber_report_settings where id=1 for update;
 if not config.enabled or config.organization_id is distinct from p_org or config.revision is distinct from p_revision then raise exception 'Report configuration changed';end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>20000 or jsonb_typeof(p_counts) is distinct from 'object'
  or p_hash is null or p_hash!~'^[a-f0-9]{64}$' or p_type is null or p_type not in('trip_activity','driver_activity','driver_quality') then raise exception 'Invalid Uber report';end if;
 promoted:=public.uber_report_promote_identities(p_org,p_rows,config.city_agencies,p_hash,p_type);
 -- Original validation and writes remain in the same transaction. A malformed
 -- metric, duplicate target or invalid demand batch rolls promotion back too.
 result:=public.uber_driver_report_commit_without_identity_promotion(p_org,p_revision,p_hash,p_type,p_batches,p_rows,
  p_counts||jsonb_build_object('identities_promoted',promoted),p_from,p_to);
 return result;
end $function$;

CREATE OR REPLACE FUNCTION public.uber_driver_report_commit_without_identity_promotion(p_org uuid, p_revision bigint, p_hash text, p_type text, p_batches jsonb, p_rows jsonb, p_counts jsonb, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare config public.uber_report_settings;entry jsonb;target uuid;matched integer:=0;unmatched integer:=0;duplicate boolean;counts jsonb;demand jsonb;seen uuid[]:='{}';
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.uber_report_commit(p_org uuid, p_revision bigint, p_hash text, p_batches jsonb, p_counts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare config public.uber_report_settings; batch jsonb; results jsonb:='[]'; result jsonb; prior public.uber_report_import_log;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
 select * into config from public.uber_report_settings where id=1 for update;
 if not config.enabled or config.organization_id is distinct from p_org or config.revision is distinct from p_revision then raise exception 'Report configuration changed';end if;
 if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_batches) is distinct from 'array' or jsonb_array_length(p_batches)>2
  or jsonb_typeof(p_counts) is distinct from 'object' or pg_column_size(p_counts)>16384 then raise exception 'Invalid report batch';end if;
 if exists(select 1 from jsonb_array_elements(p_batches) b where coalesce(b->>'city','') not in('Casablanca','Marrakech')
   or config.city_agencies->>(b->>'city') is distinct from b->>'agency_id')
  or exists(select 1 from jsonb_array_elements(p_batches) b group by b->>'city' having count(*)>1) then raise exception 'Report agency mismatch';end if;
 select * into prior from public.uber_report_import_log where organization_id=p_org and config_revision=p_revision and file_sha256=p_hash;
 if found then
  update public.uber_report_settings set last_success_at=now(),last_attempt_at=now(),last_status=case when jsonb_array_length(prior.results)=0 then 'empty' else 'imported' end,last_error=null,last_counts=prior.counts where id=1;
  return jsonb_build_object('duplicate',true,'results',prior.results,'counts',prior.counts);
 end if;
 for batch in select value from jsonb_array_elements(p_batches) loop
  result:=public.ops_import_demand(batch,batch->'rows');
  results:=results||jsonb_build_array(jsonb_build_object('city',batch->>'city','agency_id',(batch->>'agency_id')::bigint,'result',result));
 end loop;
 insert into public.uber_report_import_log(organization_id,config_revision,file_sha256,counts,results) values(p_org,p_revision,p_hash,p_counts,results);
 update public.uber_report_settings set last_success_at=now(),last_attempt_at=now(),last_status=case when jsonb_array_length(p_batches)=0 then 'empty' else 'imported' end,
  last_error=null,last_counts=p_counts where id=1;
 return jsonb_build_object('duplicate',false,'results',results,'counts',p_counts);
end $function$;

CREATE OR REPLACE FUNCTION public.uber_report_configure(p_enabled boolean, p_org uuid, p_mapping jsonb, p_format text, p_user uuid, p_org_label text DEFAULT NULL::text, p_csv_timezone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare result public.uber_report_settings; label text:=btrim(p_org_label);
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
 if not exists(select 1 from public.profiles where user_id=p_user and role='admin') then raise exception 'Administrator required';end if;
 if p_enabled is null or p_format is null or p_format not in('dmy','ymd','mdy') or jsonb_typeof(p_mapping) is distinct from 'object'
  or exists(select 1 from jsonb_each(p_mapping) e where e.key not in('Casablanca','Marrakech') or jsonb_typeof(e.value)<>'number'
   or e.value::text !~ '^[1-9][0-9]*$' or not exists(select 1 from public.agencies a where a.id=(e.value::text)::bigint
     and lower(btrim(a.city))=case when e.key='Casablanca' then 'casablanca' else 'marrakech' end))
  or p_enabled and (p_org is null or p_mapping='{}'::jsonb)
  or p_csv_timezone is not null and p_csv_timezone not in('UTC','Africa/Casablanca')
  or p_org_label is not null and (length(label) not between 1 and 160 or p_org_label ~ '[[:cntrl:]]')
  then raise exception 'Invalid report configuration';end if;
 update public.uber_report_settings set enabled=p_enabled,organization_id=p_org,organization_label=label,city_agencies=p_mapping,date_format=p_format,csv_timezone=p_csv_timezone,
  revision=revision+1,updated_at=now(),last_status=case when p_enabled then 'ready' else 'unconfigured' end,last_error=null
  where id=1 returning * into result;
 return to_jsonb(result);
end $function$;

CREATE OR REPLACE FUNCTION public.uber_report_driver(p_org text, p_provider text, p_name text, p_mapping jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.uber_report_promote_identities(p_org uuid, p_rows jsonb, p_mapping jsonb, p_hash text, p_type text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare pair record;ids uuid[];identity_row public.fleet_identities;driver_row public.fleet_drivers;
 reference_row public.drivers;promoted integer:=0;changed integer;
begin
 if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production required';end if;
 -- Serialize with manual/automatic person association. The table lock also
 -- excludes a concurrent Live Map identity insertion while uniqueness is checked.
 perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
 lock table public.fleet_identities in share row exclusive mode;
 for pair in
  with pairs as materialized (
   select distinct lower(r->>'provider_driver_id') provider,public.fleet_normalized_name(r->>'driver_name') name_key
   from jsonb_array_elements(p_rows) r
   where jsonb_typeof(r)='object' and (r->>'provider_driver_id')~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    and length(coalesce(r->>'driver_name','')) between 5 and 160
  ),good_providers as (select provider from pairs group by provider having count(*)=1),
  good_names as (select name_key from pairs group by name_key having count(*)=1)
  select p.* from pairs p join good_providers using(provider) join good_names using(name_key)
   where p.name_key like '% %' and length(p.name_key)>=5 order by p.provider
 loop
  -- Existing UUID evidence is authoritative and is never moved/replaced.
  if exists(select 1 from public.fleet_identities where source='uber' and lower(organization_id)=p_org::text and lower(external_id)=pair.provider) then continue;end if;
  -- Count every identity in the organization, including another agency and
  -- non-provisional profiles. Scoping first would hide a same-name conflict.
  select array_agg(i.id) into ids from public.fleet_identities i join public.fleet_drivers d on d.id=i.driver_id
   where i.source='uber' and lower(i.organization_id)=p_org::text and public.fleet_normalized_name(d.name)=pair.name_key;
  if cardinality(ids) is distinct from 1 then continue;end if;
  select * into identity_row from public.fleet_identities where id=ids[1] for update;
  if not identity_row.provisional or identity_row.external_id is not null then continue;end if;
  select * into driver_row from public.fleet_drivers where id=identity_row.driver_id for update;
  if driver_row.ludy_driver_code is null or driver_row.link_method is null or driver_row.link_method not in('manual','exact_name','name_spacing')
   or driver_row.agency_id is null or public.fleet_normalized_name(driver_row.name) is distinct from pair.name_key
   or not exists(select 1 from jsonb_each(p_mapping) m where m.value=to_jsonb(driver_row.agency_id)) then continue;end if;
  select * into reference_row from public.drivers where code=driver_row.ludy_driver_code for share;
  if not found or reference_row.agency_id is distinct from driver_row.agency_id then continue;end if;
  update public.fleet_identities set external_id=pair.provider,provisional=false
   where id=identity_row.id and provisional and external_id is null;
  get diagnostics changed=row_count;
  if changed=1 then
   insert into public.fleet_link_audit(driver_id,action,method,evidence)
    values(driver_row.id,'provider_identity','uber_report_uuid_exact_name',jsonb_build_object(
     'identity_id',identity_row.id,'organization_id',p_org,'provider_driver_id',pair.provider,
     'normalized_name',pair.name_key,'ludy_driver_code',driver_row.ludy_driver_code,
     'link_method',driver_row.link_method,'agency_id',driver_row.agency_id,
     'file_sha256',p_hash,'report_type',p_type,'source_key_preserved',true));
   promoted:=promoted+1;
  end if;
 end loop;
 return promoted;
end $function$;
revoke all on function public.desktop_admin_request(uuid,text,text,jsonb,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.desktop_admin_request(uuid,text,text,jsonb,jsonb,text) to authenticated;
revoke all on function public.desktop_manager_request(text,text,jsonb,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.desktop_manager_request(text,text,jsonb,jsonb,text) to authenticated;
revoke all on function public.desktop_vehicle_live_stamp() from public, anon, authenticated, service_role;
revoke all on function public.desktop_worker_claim(uuid) from public, anon, authenticated, service_role;
grant execute on function public.desktop_worker_claim(uuid) to authenticated;
revoke all on function public.desktop_worker_register(uuid,text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.desktop_worker_register(uuid,text,boolean) to authenticated;
revoke all on function public.desktop_worker_release(uuid,bigint) from public, anon, authenticated, service_role;
grant execute on function public.desktop_worker_release(uuid,bigint) to authenticated;
revoke all on function public.desktop_worker_renew(uuid,bigint) from public, anon, authenticated, service_role;
grant execute on function public.desktop_worker_renew(uuid,bigint) to authenticated;
revoke all on function public.desktop_worker_request(uuid,bigint,text,text,jsonb,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.desktop_worker_request(uuid,bigint,text,text,jsonb,jsonb,text) to authenticated;
revoke all on function public.desktop_worker_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.desktop_worker_status(uuid) to authenticated;
revoke all on function public.driver_portal_login(text,text) from public, anon, authenticated, service_role;
grant execute on function public.driver_portal_login(text,text) to service_role;
revoke all on function public.driver_portal_rotate(uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.driver_portal_rotate(uuid,text,uuid) to service_role;
revoke all on function public.fleet_archive_parking_zone(uuid,bigint,uuid) from public, anon, authenticated, service_role;
grant execute on function public.fleet_archive_parking_zone(uuid,bigint,uuid) to service_role;
revoke all on function public.fleet_auto_link_driver(uuid,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.fleet_auto_link_driver(uuid,text,text,text) to service_role;
revoke all on function public.fleet_auto_link_driver_spacing(uuid,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.fleet_auto_link_driver_spacing(uuid,text,text,text) to service_role;
revoke all on function public.fleet_auto_link_driver_spacing_base(uuid,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.fleet_auto_link_myclicar_vehicle(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.fleet_auto_link_myclicar_vehicle(uuid,text) to service_role;
revoke all on function public.fleet_auto_link_myclicar_vehicle_contract_base(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.fleet_auto_link_vehicle(uuid,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.fleet_auto_link_vehicle(uuid,text,jsonb) to service_role;
revoke all on function public.fleet_auto_link_vehicle_platform_base(uuid,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fleet_can_read(uuid) from public, anon, authenticated, service_role;
grant execute on function public.fleet_can_read(uuid) to authenticated;
grant execute on function public.fleet_can_read(uuid) to service_role;
revoke all on function public.fleet_commit_disconnections(jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.fleet_commit_disconnections(jsonb,jsonb,jsonb) to service_role;
revoke all on function public.fleet_commit_parking(jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.fleet_commit_parking(jsonb,jsonb) to service_role;
revoke all on function public.fleet_current_vehicle_claims() from public, anon, authenticated, service_role;
revoke all on function public.fleet_import_bolt_performance(text,jsonb,jsonb,timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.fleet_import_bolt_performance(text,jsonb,jsonb,timestamp with time zone) to service_role;
revoke all on function public.fleet_link_driver(uuid,text,text,bigint) from public, anon, authenticated, service_role;
grant execute on function public.fleet_link_driver(uuid,text,text,bigint) to service_role;
revoke all on function public.fleet_link_driver_automatic(uuid,text,bigint) from public, anon, authenticated, service_role;
grant execute on function public.fleet_link_driver_automatic(uuid,text,bigint) to service_role;
revoke all on function public.fleet_link_driver_base(uuid,text,text,bigint) from public, anon, authenticated, service_role;
revoke all on function public.fleet_link_driver_reference_base(uuid,text,text,bigint) from public, anon, authenticated, service_role;
revoke all on function public.fleet_myclicar_agency_label(text) from public, anon, authenticated, service_role;
grant execute on function public.fleet_myclicar_agency_label(text) to service_role;
revoke all on function public.fleet_myclicar_plate(text) from public, anon, authenticated, service_role;
grant execute on function public.fleet_myclicar_plate(text) to service_role;
revoke all on function public.fleet_normalized_name(text) from public, anon, authenticated, service_role;
grant execute on function public.fleet_normalized_name(text) to service_role;
revoke all on function public.fleet_parking_zone_reset() from public, anon, authenticated, service_role;
grant execute on function public.fleet_parking_zone_reset() to service_role;
revoke all on function public.fleet_preserve_disconnections_on_merge() from public, anon, authenticated, service_role;
revoke all on function public.fleet_reconcile_vehicle_contracts() from public, anon, authenticated, service_role;
grant execute on function public.fleet_reconcile_vehicle_contracts() to service_role;
revoke all on function public.fleet_reconcile_vehicle_contracts_identity_base() from public, anon, authenticated, service_role;
revoke all on function public.fleet_reconcile_vehicle_contracts_shift_base() from public, anon, authenticated, service_role;
revoke all on function public.fleet_save_motion_checkpoints(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.fleet_save_motion_checkpoints(jsonb) to service_role;
revoke all on function public.fleet_source_health() from public, anon, authenticated, service_role;
grant execute on function public.fleet_source_health() to authenticated;
revoke all on function public.fleet_spaced_name_key(text) from public, anon, authenticated, service_role;
grant execute on function public.fleet_spaced_name_key(text) to service_role;
revoke all on function public.fleet_sync_inventory(jsonb,jsonb,timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.fleet_sync_inventory(jsonb,jsonb,timestamp with time zone) to service_role;
revoke all on function public.fleet_sync_myclicar(jsonb,timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.fleet_sync_myclicar(jsonb,timestamp with time zone) to service_role;
revoke all on function public.fleet_sync_myclicar_reference_base(jsonb,timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.fleet_sync_rotation_contracts(jsonb,timestamp with time zone,timestamp with time zone,timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.fleet_sync_rotation_contracts(jsonb,timestamp with time zone,timestamp with time zone,timestamp with time zone) to service_role;
revoke all on function public.fleet_sync_rotation_contracts_history_base(jsonb,timestamp with time zone,timestamp with time zone,timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.fleet_vehicle_observation_current(text,text,timestamp with time zone,jsonb,text,timestamp with time zone,integer) from public, anon, authenticated, service_role;
grant execute on function public.fleet_vehicle_observation_current(text,text,timestamp with time zone,jsonb,text,timestamp with time zone,integer) to service_role;
revoke all on function public.ludy_desktop_geotab_legacy_guard() from public, anon, authenticated, service_role;
revoke all on function public.ops_can_read_agency(bigint) from public, anon, authenticated, service_role;
grant execute on function public.ops_can_read_agency(bigint) to authenticated;
grant execute on function public.ops_can_read_agency(bigint) to service_role;
revoke all on function public.ops_import_demand(jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.ops_import_demand(jsonb,jsonb) to service_role;
revoke all on function public.ops_ingest_events(text,jsonb,timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.ops_ingest_events(text,jsonb,timestamp with time zone) to service_role;
revoke all on function public.ops_mutate_manual_event(text,uuid,text,jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.ops_mutate_manual_event(text,uuid,text,jsonb,uuid) to service_role;
revoke all on function public.ops_review_event(uuid,text,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.ops_review_event(uuid,text,text,uuid) to service_role;
revoke all on function public.ops_set_measured_fuel_reference(text,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.ops_set_measured_fuel_reference(text,text,jsonb) to service_role;
revoke all on function public.provider_earnings_amounts_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.provider_earnings_commit(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.provider_earnings_commit(jsonb) to service_role;
revoke all on function public.provider_earnings_provenance_valid(jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.provider_earnings_reconcile(uuid,bigint,integer,text,bigint,text,text,boolean,boolean) from public, anon, authenticated, service_role;
grant execute on function public.provider_earnings_reconcile(uuid,bigint,integer,text,bigint,text,text,boolean,boolean) to authenticated;
revoke all on function public.provider_earnings_reconciliation_queue(uuid) from public, anon, authenticated, service_role;
grant execute on function public.provider_earnings_reconciliation_queue(uuid) to authenticated;
revoke all on function public.provider_earnings_select_windows(timestamp with time zone,timestamp with time zone,uuid[],bigint,text) from public, anon, authenticated, service_role;
grant execute on function public.provider_earnings_select_windows(timestamp with time zone,timestamp with time zone,uuid[],bigint,text) to authenticated;
revoke all on function public.revenue_refresh_after_statement() from public, anon, authenticated, service_role;
revoke all on function public.rls_auto_enable() from public, anon, authenticated, service_role;
grant execute on function public.rls_auto_enable() to public;
grant execute on function public.rls_auto_enable() to anon;
grant execute on function public.rls_auto_enable() to authenticated;
grant execute on function public.rls_auto_enable() to service_role;
revoke all on function public.telemetry_archive_immutable() from public, anon, authenticated, service_role;
revoke all on function public.telemetry_archive_ingest(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.telemetry_archive_ingest(jsonb) to service_role;
revoke all on function public.uber_driver_report_commit(uuid,bigint,text,text,jsonb,jsonb,jsonb,timestamp with time zone,timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.uber_driver_report_commit(uuid,bigint,text,text,jsonb,jsonb,jsonb,timestamp with time zone,timestamp with time zone) to service_role;
revoke all on function public.uber_driver_report_commit_without_identity_promotion(uuid,bigint,text,text,jsonb,jsonb,jsonb,timestamp with time zone,timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.uber_report_commit(uuid,bigint,text,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.uber_report_commit(uuid,bigint,text,jsonb,jsonb) to service_role;
revoke all on function public.uber_report_configure(boolean,uuid,jsonb,text,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.uber_report_configure(boolean,uuid,jsonb,text,uuid,text,text) to service_role;
revoke all on function public.uber_report_driver(text,text,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.uber_report_driver(text,text,text,jsonb) to service_role;
revoke all on function public.uber_report_promote_identities(uuid,jsonb,jsonb,text,text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------- Clés, contrôles et index
alter table public.desktop_vehicle_live add constraint desktop_vehicle_live_pkey PRIMARY KEY (vehicle_key);
alter table public.desktop_vehicle_live add constraint desktop_vehicle_live_data_check CHECK (((jsonb_typeof(data) = 'object'::text) AND (pg_column_size(data) <= 65536) AND (jsonb_typeof((data -> 'device_id'::text)) = 'string'::text) AND (jsonb_typeof((data -> 'captured_at'::text)) = 'string'::text)));
alter table public.desktop_worker_devices add constraint desktop_worker_devices_pkey PRIMARY KEY (id);
alter table public.desktop_worker_devices add constraint desktop_worker_devices_label_check CHECK ((((char_length(label) >= 1) AND (char_length(label) <= 120)) AND (label !~ '[[:cntrl:]]'::text)));
alter table public.desktop_worker_leases add constraint desktop_worker_leases_pkey PRIMARY KEY (scope);
alter table public.desktop_worker_leases add constraint desktop_worker_leases_fence_check CHECK (((fence >= 0) AND (fence <= '9007199254740991'::bigint)));
alter table public.desktop_worker_leases add constraint desktop_worker_leases_scope_check CHECK ((scope = 'workspace'::text));
alter table public.driver_notifications add constraint driver_notifications_pkey PRIMARY KEY (id);
alter table public.driver_notifications add constraint driver_notifications_account_id_event_key_key UNIQUE (account_id, event_key);
alter table public.driver_notifications add constraint driver_notifications_event_key_check CHECK (((length(event_key) >= 1) AND (length(event_key) <= 240)));
alter table public.driver_notifications add constraint driver_notifications_evidence_check CHECK (((jsonb_typeof(evidence) = 'object'::text) AND (pg_column_size(evidence) <= 32768)));
alter table public.driver_notifications add constraint driver_notifications_kind_check CHECK ((kind = ANY (ARRAY['overconsumption'::text, 'speeding'::text, 'harsh_driving'::text, 'info'::text])));
alter table public.driver_notifications add constraint driver_notifications_message_check CHECK (((length(message) >= 1) AND (length(message) <= 1000)));
alter table public.driver_notifications add constraint driver_notifications_observed_at_check CHECK (isfinite(observed_at));
alter table public.driver_notifications add constraint driver_notifications_title_check CHECK (((length(title) >= 1) AND (length(title) <= 160)));
alter table public.driver_portal_accounts add constraint driver_portal_accounts_pkey PRIMARY KEY (id);
alter table public.driver_portal_accounts add constraint driver_portal_accounts_credential_hash_key UNIQUE (credential_hash);
alter table public.driver_portal_accounts add constraint driver_portal_accounts_ludy_driver_code_key UNIQUE (ludy_driver_code);
alter table public.driver_portal_accounts add constraint driver_portal_accounts_credential_hash_check CHECK ((credential_hash ~ '^[0-9a-f]{64}$'::text));
alter table public.driver_portal_accounts add constraint driver_portal_accounts_display_name_check CHECK (((length(display_name) >= 1) AND (length(display_name) <= 160)));
alter table public.driver_portal_sessions add constraint driver_portal_sessions_pkey PRIMARY KEY (token_hash);
alter table public.driver_portal_sessions add constraint driver_portal_sessions_check CHECK ((isfinite(expires_at) AND (expires_at > created_at)));
alter table public.driver_portal_sessions add constraint driver_portal_sessions_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text));
alter table public.driver_reports add constraint driver_reports_pkey PRIMARY KEY (id);
alter table public.driver_reports add constraint driver_reports_admin_note_check CHECK ((length(admin_note) <= 1000));
alter table public.driver_reports add constraint driver_reports_category_check CHECK ((category = ANY (ARRAY['accident'::text, 'traffic'::text, 'incident'::text])));
alter table public.driver_reports add constraint driver_reports_city_check CHECK ((city = ANY (ARRAY['Casablanca'::text, 'Marrakech'::text, 'Autre'::text])));
alter table public.driver_reports add constraint driver_reports_description_check CHECK (((length(btrim(description)) >= 5) AND (length(btrim(description)) <= 2000)));
alter table public.driver_reports add constraint driver_reports_place_check CHECK (((length(btrim(place)) >= 2) AND (length(btrim(place)) <= 240)));
alter table public.driver_reports add constraint driver_reports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text, 'closed'::text])));
alter table public.fleet_alerts add constraint fleet_alerts_pkey PRIMARY KEY (id);
alter table public.fleet_alerts add constraint fleet_alerts_identity_id_observed_since_key UNIQUE (identity_id, observed_since);
alter table public.fleet_alerts add constraint fleet_alerts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'suspended'::text])));
alter table public.fleet_contract_assignment_overrides add constraint fleet_contract_assignment_overrides_pkey PRIMARY KEY (contract_id);
alter table public.fleet_contract_assignment_overrides add constraint fleet_contract_assignment_overrides_latest_conflict_at_check CHECK (isfinite(latest_conflict_at));
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_pkey PRIMARY KEY (id);
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_identity_id_disconnected_at_duty_key UNIQUE (identity_id, disconnected_at, duty_key);
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_check CHECK ((isfinite(disconnected_at) AND (disconnected_at > observed_online_at)));
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_check1 CHECK ((((status = 'resolved'::text) AND (resolved_at IS NOT NULL) AND (resolved_at >= disconnected_at)) OR ((status = ANY (ARRAY['open'::text, 'suspended'::text])) AND (resolved_at IS NULL))));
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_contract_id_check CHECK (((contract_id IS NULL) OR ((length(contract_id) >= 1) AND (length(contract_id) <= 120))));
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_duty_key_check CHECK (((length(duty_key) >= 1) AND (length(duty_key) <= 500)));
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_evidence_check CHECK (((jsonb_typeof(evidence) = 'object'::text) AND (pg_column_size(evidence) <= 32768)));
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_last_seen_at_check CHECK (isfinite(last_seen_at));
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_observed_online_at_check CHECK (isfinite(observed_online_at));
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_opened_at_check CHECK (isfinite(opened_at));
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_resolved_at_check CHECK (((resolved_at IS NULL) OR isfinite(resolved_at)));
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_source_check CHECK ((source = ANY (ARRAY['uber'::text, 'bolt'::text])));
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'suspended'::text, 'resolved'::text])));
alter table public.fleet_disconnection_checkpoints add constraint fleet_disconnection_checkpoints_pkey PRIMARY KEY (identity_id);
alter table public.fleet_disconnection_checkpoints add constraint fleet_disconnection_checkpoints_state_check CHECK (((jsonb_typeof(state) = 'object'::text) AND (pg_column_size(state) <= 32768)));
alter table public.fleet_disconnection_checkpoints add constraint fleet_disconnection_checkpoints_updated_at_check CHECK (isfinite(updated_at));
alter table public.fleet_driver_performance_sync add constraint fleet_driver_performance_sync_pkey PRIMARY KEY (source, organization_id, driver_id);
alter table public.fleet_driver_performance_sync add constraint fleet_driver_performance_sync_check CHECK ((((covered_from IS NULL) AND (covered_to IS NULL)) OR ((covered_from IS NOT NULL) AND (covered_to IS NOT NULL) AND (covered_to > covered_from))));
alter table public.fleet_driver_performance_sync add constraint fleet_driver_performance_sync_row_count_check CHECK ((row_count >= 0));
alter table public.fleet_driver_performance_sync add constraint fleet_driver_performance_sync_source_check CHECK ((source = ANY (ARRAY['uber'::text, 'bolt'::text])));
alter table public.fleet_driver_performance_sync add constraint fleet_driver_performance_sync_status_check CHECK ((status = ANY (ARRAY['unconnected'::text, 'healthy'::text, 'error'::text])));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_pkey PRIMARY KEY (source, organization_id, driver_id, report_type, period_from, period_to);
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_acceptance_rate_check CHECK (((acceptance_rate >= (0)::numeric) AND (acceptance_rate <= (1)::numeric)));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_accepted_count_check CHECK ((accepted_count >= 0));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_cancellation_rate_check CHECK (((cancellation_rate >= (0)::numeric) AND (cancellation_rate <= (1)::numeric)));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_cancelled_count_check CHECK ((cancelled_count >= 0));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_check CHECK ((period_to > period_from));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_completion_rate_check CHECK (((completion_rate >= (0)::numeric) AND (completion_rate <= (1)::numeric)));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_online_seconds_check CHECK ((online_seconds >= (0)::numeric));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_rejected_count_check CHECK ((rejected_count >= 0));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_report_type_check CHECK ((report_type = ANY (ARRAY['driver_activity'::text, 'driver_quality'::text])));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_source_check CHECK ((source = 'uber'::text));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_trip_seconds_check CHECK ((trip_seconds >= (0)::numeric));
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_trips_completed_check CHECK ((trips_completed >= 0));
alter table public.fleet_drivers add constraint fleet_drivers_pkey PRIMARY KEY (id);
alter table public.fleet_identities add constraint fleet_identities_pkey PRIMARY KEY (id);
alter table public.fleet_identities add constraint fleet_identities_source_source_key_key UNIQUE (source, source_key);
alter table public.fleet_inventory_sync add constraint fleet_inventory_sync_pkey PRIMARY KEY (id);
alter table public.fleet_inventory_sync add constraint fleet_inventory_sync_id_check CHECK ((id = 1));
alter table public.fleet_inventory_sync add constraint fleet_inventory_sync_status_check CHECK ((status = ANY (ARRAY['unconnected'::text, 'healthy'::text, 'error'::text])));
alter table public.fleet_latest add constraint fleet_latest_pkey PRIMARY KEY (identity_id);
alter table public.fleet_link_audit add constraint fleet_link_audit_pkey PRIMARY KEY (id);
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_pkey PRIMARY KEY (id);
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_identity_id_vehicle_key_observed_since_key UNIQUE (identity_id, vehicle_key, observed_since);
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_distance_m_check CHECK ((distance_m > (200)::numeric));
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_kind_check CHECK ((kind = 'offline_movement'::text));
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_severity_check CHECK ((severity = 'critical'::text));
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_source_check CHECK ((source = ANY (ARRAY['uber'::text, 'bolt'::text])));
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'suspended'::text])));
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_threshold_m_check CHECK ((threshold_m = 200));
alter table public.fleet_motion_checkpoints add constraint fleet_motion_checkpoints_pkey PRIMARY KEY (identity_id);
alter table public.fleet_motion_checkpoints add constraint fleet_motion_checkpoints_check CHECK ((((state ->> 'identity_id'::text) = (identity_id)::text) AND ((state ->> 'vehicle_key'::text) = vehicle_key) AND ((state ->> 'source'::text) = source)));
alter table public.fleet_motion_checkpoints add constraint fleet_motion_checkpoints_source_check CHECK ((source = ANY (ARRAY['uber'::text, 'bolt'::text])));
alter table public.fleet_motion_checkpoints add constraint fleet_motion_checkpoints_state_check CHECK (((jsonb_typeof(state) = 'object'::text) AND (state ?& ARRAY['identity_id'::text, 'vehicle_key'::text, 'source'::text, 'version'::text]) AND ((state ->> 'version'::text) = '1'::text)));
alter table public.fleet_myclicar_agencies add constraint fleet_myclicar_agencies_pkey PRIMARY KEY (external_id);
alter table public.fleet_myclicar_agencies add constraint fleet_myclicar_agencies_check CHECK ((((length(code) >= 1) AND (length(code) <= 120)) AND ((length(name) >= 1) AND (length(name) <= 160))));
alter table public.fleet_myclicar_agencies add constraint fleet_myclicar_agencies_external_id_check CHECK (((length(external_id) >= 1) AND (length(external_id) <= 120)));
alter table public.fleet_myclicar_contracts add constraint fleet_myclicar_contracts_pkey PRIMARY KEY (external_id);
alter table public.fleet_myclicar_contracts add constraint fleet_myclicar_contracts_num_key UNIQUE (num);
alter table public.fleet_myclicar_contracts add constraint fleet_myclicar_contracts_check CHECK ((((length(external_id) >= 1) AND (length(external_id) <= 120)) AND ((length(num) >= 1) AND (length(num) <= 120))));
alter table public.fleet_myclicar_vehicles add constraint fleet_myclicar_vehicles_pkey PRIMARY KEY (external_id);
alter table public.fleet_myclicar_vehicles add constraint fleet_myclicar_vehicles_check CHECK ((((length(reference) >= 1) AND (length(reference) <= 120)) AND (length(plate) <= 120) AND (length(temporary_plate) <= 120) AND (length(vin) <= 120)));
alter table public.fleet_myclicar_vehicles add constraint fleet_myclicar_vehicles_external_id_check CHECK (((length(external_id) >= 1) AND (length(external_id) <= 120)));
alter table public.fleet_myclicar_vehicles add constraint fleet_myclicar_vehicles_status_check CHECK ((status = ANY (ARRAY['AVAILABLE'::text, 'RENTED'::text, 'RESERVED'::text])));
alter table public.fleet_observations add constraint fleet_observations_pkey PRIMARY KEY (id);
alter table public.fleet_observations add constraint fleet_observations_identity_id_observed_at_key UNIQUE (identity_id, observed_at);
alter table public.fleet_observations add constraint fleet_observations_status_check CHECK ((status = ANY (ARRAY['available'::text, 'on_trip'::text, 'to_pickup'::text, 'offline'::text, 'unknown'::text, 'on_break'::text])));
alter table public.fleet_parking_events add constraint fleet_parking_events_pkey PRIMARY KEY (event_key);
alter table public.fleet_parking_events add constraint fleet_parking_events_check CHECK ((first_observed_at <= observed_at));
alter table public.fleet_parking_events add constraint fleet_parking_events_event_key_check CHECK ((event_key ~ '^[a-f0-9]{64}$'::text));
alter table public.fleet_parking_events add constraint fleet_parking_events_kind_check CHECK ((kind = ANY (ARRAY['entered'::text, 'exited'::text])));
alter table public.fleet_parking_state add constraint fleet_parking_state_pkey PRIMARY KEY (vehicle_key, zone_id);
alter table public.fleet_parking_state add constraint fleet_parking_state_state_check CHECK ((pg_column_size(state) < 8192));
alter table public.fleet_parking_zones add constraint fleet_parking_zones_pkey PRIMARY KEY (id);
alter table public.fleet_parking_zones add constraint fleet_parking_zones_source_source_id_key UNIQUE (source, source_id);
alter table public.fleet_parking_zones add constraint fleet_operating_agency_required CHECK (((kind <> 'operating'::text) OR (agency_id IS NOT NULL)));
alter table public.fleet_parking_zones add constraint fleet_parking_archive_actor CHECK (((archived_at IS NOT NULL) OR (archived_by IS NULL)));
alter table public.fleet_parking_zones add constraint fleet_parking_archive_disabled CHECK (((archived_at IS NULL) OR (isfinite(archived_at) AND (NOT enabled))));
alter table public.fleet_parking_zones add constraint fleet_parking_zones_fingerprint_check CHECK ((fingerprint ~ '^[a-f0-9]{64}$'::text));
alter table public.fleet_parking_zones add constraint fleet_parking_zones_kind_check CHECK ((kind = ANY (ARRAY['parking'::text, 'exclusion'::text, 'operating'::text])));
alter table public.fleet_parking_zones add constraint fleet_parking_zones_name_check CHECK (((length(name) >= 1) AND (length(name) <= 120)));
alter table public.fleet_parking_zones add constraint fleet_parking_zones_revision_check CHECK ((revision > 0));
alter table public.fleet_parking_zones add constraint fleet_parking_zones_shape_check CHECK (((jsonb_typeof(shape) = 'object'::text) AND (pg_column_size(shape) < 65536)));
alter table public.fleet_parking_zones add constraint fleet_parking_zones_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'geotab'::text])));
alter table public.fleet_provider_vehicles add constraint fleet_provider_vehicles_pkey PRIMARY KEY (source, organization_id, external_id);
alter table public.fleet_rides add constraint fleet_rides_pkey PRIMARY KEY (source, organization_id, external_id);
alter table public.fleet_rides add constraint fleet_rides_detail_origin_check CHECK ((detail_origin = ANY (ARRAY['legacy'::text, 'bolt_api'::text, 'uber_report'::text])));
alter table public.fleet_rides add constraint fleet_rides_passenger_distance_km_check CHECK ((passenger_distance_km >= (0)::numeric));
alter table public.fleet_rides add constraint fleet_rides_pickup_duration_s_check CHECK ((pickup_duration_s >= (0)::numeric));
alter table public.fleet_rides add constraint fleet_rides_stops_check CHECK (((jsonb_typeof(stops) = 'array'::text) AND (jsonb_array_length(stops) <= 30) AND (pg_column_size(stops) <= 16384)));
alter table public.fleet_rotation_contracts add constraint fleet_rotation_contracts_pkey PRIMARY KEY (external_id);
alter table public.fleet_rotation_contracts add constraint fleet_rotation_contracts_check CHECK (((end_at IS NULL) OR (isfinite(end_at) AND ((effective_start_at IS NULL) OR (end_at >= effective_start_at)))));
alter table public.fleet_rotation_contracts add constraint fleet_rotation_contracts_effective_start_at_check CHECK (((effective_start_at IS NULL) OR isfinite(effective_start_at)));
alter table public.fleet_rotation_contracts add constraint fleet_rotation_contracts_external_id_check CHECK (((length(external_id) >= 1) AND (length(external_id) <= 120)));
alter table public.fleet_rotation_contracts add constraint fleet_rotation_contracts_num_check CHECK (((length(num) >= 1) AND (length(num) <= 120)));
alter table public.fleet_rotation_contracts add constraint fleet_rotation_contracts_status_check CHECK ((status = ANY (ARRAY['DONE'::text, 'VEHICLE_RETURNED'::text])));
alter table public.fleet_rotation_sync add constraint fleet_rotation_sync_pkey PRIMARY KEY (id);
alter table public.fleet_rotation_sync add constraint fleet_rotation_sync_id_check CHECK ((id = 1));
alter table public.fleet_rotation_sync add constraint fleet_rotation_sync_status_check CHECK ((status = ANY (ARRAY['unconnected'::text, 'healthy'::text, 'error'::text])));
alter table public.fleet_settings add constraint fleet_settings_pkey PRIMARY KEY (id);
alter table public.fleet_settings add constraint fleet_settings_disconnection_policy_check CHECK ((disconnection_policy = ANY (ARRAY['any'::text, 'all'::text])));
alter table public.fleet_settings add constraint fleet_settings_duty_mode_check CHECK ((duty_mode = ANY (ARRAY['contract'::text, 'shift'::text])));
alter table public.fleet_settings add constraint fleet_settings_id_check CHECK ((id = 1));
alter table public.fleet_settings add constraint fleet_settings_offline_threshold_s_check CHECK (((offline_threshold_s >= 60) AND (offline_threshold_s <= 86400)));
alter table public.fleet_source_events add constraint fleet_source_events_pkey PRIMARY KEY (id);
alter table public.fleet_sources add constraint fleet_sources_pkey PRIMARY KEY (id);
alter table public.fleet_sources add constraint fleet_sources_id_check CHECK ((id = ANY (ARRAY['uber'::text, 'bolt'::text, 'geotab'::text, 'myclicar'::text])));
alter table public.fleet_sources add constraint fleet_sources_stale_after_s_check CHECK (((stale_after_s >= 15) AND (stale_after_s <= 3600)));
alter table public.ops_demand_imports add constraint ops_demand_imports_pkey PRIMARY KEY (id);
alter table public.ops_demand_imports add constraint ops_demand_imports_agency_id_fingerprint_key UNIQUE (agency_id, fingerprint);
alter table public.ops_demand_imports add constraint ops_demand_imports_city_check CHECK ((city = ANY (ARRAY['Casablanca'::text, 'Marrakech'::text])));
alter table public.ops_demand_imports add constraint ops_demand_imports_file_name_check CHECK ((length(file_name) <= 200));
alter table public.ops_demand_imports add constraint ops_demand_imports_fingerprint_check CHECK ((length(fingerprint) = 64));
alter table public.ops_demand_rides add constraint ops_demand_rides_pkey PRIMARY KEY (agency_id, ride_key);
alter table public.ops_demand_rides add constraint ops_demand_rides_city_check CHECK ((city = ANY (ARRAY['Casablanca'::text, 'Marrakech'::text])));
alter table public.ops_demand_rides add constraint ops_demand_rides_pickup_zone_check CHECK (((length(pickup_zone) >= 1) AND (length(pickup_zone) <= 200)));
alter table public.ops_demand_rides add constraint ops_demand_rides_ride_key_check CHECK ((length(ride_key) = 64));
alter table public.ops_demand_rides add constraint ops_demand_rides_status_check CHECK ((status = ANY (ARRAY['completed'::text, 'cancelled'::text])));
alter table public.ops_event_reviews add constraint ops_event_reviews_pkey PRIMARY KEY (id);
alter table public.ops_event_reviews add constraint ops_event_reviews_decision_check CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text])));
alter table public.ops_event_sources add constraint ops_event_sources_pkey PRIMARY KEY (id);
alter table public.ops_events add constraint ops_events_pkey PRIMARY KEY (id);
alter table public.ops_events add constraint ops_events_source_id_external_key_key UNIQUE (source_id, external_key);
alter table public.ops_events add constraint ops_events_check CHECK (((ends_at IS NULL) OR ((starts_at IS NOT NULL) AND (ends_at >= starts_at))));
alter table public.ops_events add constraint ops_events_city_check CHECK ((city = ANY (ARRAY['Casablanca'::text, 'Marrakech'::text])));
alter table public.ops_events add constraint ops_events_manual_only CHECK ((source_id = 'manual'::text));
alter table public.ops_events add constraint ops_events_place_check CHECK ((length(place) <= 240));
alter table public.ops_events add constraint ops_events_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
alter table public.ops_events add constraint ops_events_time_precision_check CHECK ((time_precision = ANY (ARRAY['minute'::text, 'day'::text, 'unknown'::text])));
alter table public.ops_events add constraint ops_events_title_check CHECK (((length(title) >= 1) AND (length(title) <= 240)));
alter table public.ops_fuel_checkpoints add constraint ops_fuel_checkpoints_pkey PRIMARY KEY (vehicle_key);
alter table public.ops_fuel_reference_runs add constraint ops_fuel_reference_runs_pkey PRIMARY KEY (id);
alter table public.ops_fuel_reference_runs add constraint ops_fuel_reference_runs_id_check CHECK ((id = 1));
alter table public.ops_fuel_reference_runs add constraint ops_fuel_reference_runs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'reading'::text, 'complete'::text, 'waiting'::text])));
alter table public.ops_fuel_settings add constraint ops_fuel_settings_pkey PRIMARY KEY (id);
alter table public.ops_fuel_settings add constraint ops_fuel_settings_cooldown_minutes_check CHECK (((cooldown_minutes >= 15) AND (cooldown_minutes <= 1440)));
alter table public.ops_fuel_settings add constraint ops_fuel_settings_excess_pct_check CHECK (((excess_pct >= (5)::numeric) AND (excess_pct <= (200)::numeric)));
alter table public.ops_fuel_settings add constraint ops_fuel_settings_id_check CHECK ((id = 1));
alter table public.ops_fuel_settings add constraint ops_fuel_settings_min_distance_km_check CHECK (((min_distance_km >= (5)::numeric) AND (min_distance_km <= (100)::numeric)));
alter table public.ops_rush_rules add constraint ops_rush_rules_pkey PRIMARY KEY (id);
alter table public.ops_rush_rules add constraint ops_rush_rules_check CHECK ((start <> "end"));
alter table public.ops_rush_rules add constraint ops_rush_rules_city_check CHECK ((city = ANY (ARRAY['Casablanca'::text, 'Marrakech'::text])));
alter table public.ops_rush_rules add constraint ops_rush_rules_days_check CHECK (((jsonb_typeof(days) = 'array'::text) AND ((jsonb_array_length(days) >= 1) AND (jsonb_array_length(days) <= 7))));
alter table public.ops_rush_rules add constraint ops_rush_rules_end_check CHECK (("end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text));
alter table public.ops_rush_rules add constraint ops_rush_rules_label_check CHECK ((length(label) <= 100));
alter table public.ops_rush_rules add constraint ops_rush_rules_start_check CHECK ((start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_pkey PRIMARY KEY (snapshot_id, provider_row);
alter table public.provider_earnings_rows add constraint provider_earnings_row_provenance_valid CHECK (provider_earnings_provenance_valid(amounts, financial_provenance));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_agency_rows_total_check CHECK (((agency_rows_total >= 1) AND (agency_rows_total <= 5000)));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_amounts_check CHECK (provider_earnings_amounts_valid(amounts));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_check CHECK ((((mapping_status = 'confirmed'::text) AND (provider_driver_id IS NOT NULL) AND (fleet_driver_id IS NOT NULL) AND (driver_code IS NOT NULL) AND (agency_id IS NOT NULL) AND (agency_id > 0)) OR ((mapping_status <> 'confirmed'::text) AND (driver_code IS NULL) AND (agency_id IS NULL))));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_driver_name_check CHECK (((length(driver_name) >= 1) AND (length(driver_name) <= 200)));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_driver_rows_total_check CHECK (((driver_rows_total >= 1) AND (driver_rows_total <= 5000)));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_mapping_status_check CHECK ((mapping_status = ANY (ARRAY['confirmed'::text, 'unmatched'::text, 'ambiguous'::text, 'unassociated'::text])));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_provider_row_check CHECK (((provider_row >= 0) AND (provider_row <= 4999)));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_snapshot_revision_check CHECK ((snapshot_revision > 0));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_source_check CHECK ((source = 'uber'::text));
alter table public.provider_earnings_rows add constraint provider_earnings_rows_time_zone_check CHECK ((time_zone = 'Africa/Casablanca'::text));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_pkey PRIMARY KEY (id);
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_source_organization_id_period_s_key UNIQUE (source, organization_id, period_start, period_end, currency);
alter table public.provider_earnings_snapshots add constraint provider_earnings_fleet_provenance_valid CHECK (provider_earnings_provenance_valid(fleet_amounts, financial_provenance));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_check CHECK ((isfinite(period_start) AND isfinite(period_end) AND (period_end > period_start) AND ((period_end - period_start) <= '367 days'::interval)));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_coverage_check CHECK ((pg_column_size(coverage) <= 2048));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_fleet_amounts_check CHECK (provider_earnings_amounts_valid(fleet_amounts));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_observed_at_check CHECK (isfinite(observed_at));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_period_label_check CHECK (((length(period_label) >= 1) AND (length(period_label) <= 200)));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_period_mode_check CHECK ((period_mode = ANY (ARRAY['provider'::text, 'settlement'::text, 'custom'::text])));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_revision_check CHECK ((revision > 0));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_source_check CHECK ((source = 'uber'::text));
alter table public.provider_earnings_snapshots add constraint provider_earnings_snapshots_time_zone_check CHECK ((time_zone = 'Africa/Casablanca'::text));
alter table public.revenue_refresh add constraint revenue_refresh_pkey PRIMARY KEY (agency_id);
alter table public.revenue_refresh add constraint revenue_refresh_agency_id_check CHECK ((agency_id >= 0));
alter table public.revenue_refresh add constraint revenue_refresh_version_check CHECK ((version > 0));
alter table public.telemetry_observations add constraint telemetry_observations_pkey PRIMARY KEY (id);
alter table public.telemetry_observations add constraint telemetry_observations_source_device_id_source_event_id_fin_key UNIQUE (source, device_id, source_event_id, fingerprint);
alter table public.telemetry_observations add constraint telemetry_observations_source_device_id_source_event_id_ver_key UNIQUE (source, device_id, source_event_id, version);
alter table public.telemetry_observations add constraint telemetry_observations_check CHECK ((isfinite(observed_at) AND isfinite(collected_at) AND isfinite(received_at)));
alter table public.telemetry_observations add constraint telemetry_observations_check1 CHECK ((observed_at <= (collected_at + '00:01:00'::interval)));
alter table public.telemetry_observations add constraint telemetry_observations_device_id_check CHECK (((length(device_id) >= 1) AND (length(device_id) <= 200)));
alter table public.telemetry_observations add constraint telemetry_observations_fingerprint_check CHECK ((fingerprint ~ '^[a-f0-9]{64}$'::text));
alter table public.telemetry_observations add constraint telemetry_observations_mapping_basis_check CHECK ((mapping_basis = 'current_at_receipt'::text));
alter table public.telemetry_observations add constraint telemetry_observations_observation_check CHECK (((jsonb_typeof(observation) = 'object'::text) AND (pg_column_size(observation) <= 8192)));
alter table public.telemetry_observations add constraint telemetry_observations_origin_check CHECK (((jsonb_typeof(origin) = 'object'::text) AND (pg_column_size(origin) <= 1024)));
alter table public.telemetry_observations add constraint telemetry_observations_source_check CHECK ((source = ANY (ARRAY['geotab'::text, 'texat'::text])));
alter table public.telemetry_observations add constraint telemetry_observations_source_event_id_check CHECK ((source_event_id ~ '^[a-f0-9]{64}$'::text));
alter table public.telemetry_observations add constraint telemetry_observations_vehicle_key_check CHECK (((length(vehicle_key) >= 1) AND (length(vehicle_key) <= 200)));
alter table public.telemetry_observations add constraint telemetry_observations_version_check CHECK ((version > 0));
alter table public.uber_driver_report_imports add constraint uber_driver_report_imports_pkey PRIMARY KEY (organization_id, config_revision, report_type, file_sha256, period_from, period_to);
alter table public.uber_driver_report_imports add constraint uber_driver_report_imports_check CHECK ((period_to > period_from));
alter table public.uber_driver_report_imports add constraint uber_driver_report_imports_counts_check CHECK ((pg_column_size(counts) <= 16384));
alter table public.uber_driver_report_imports add constraint uber_driver_report_imports_file_sha256_check CHECK ((file_sha256 ~ '^[a-f0-9]{64}$'::text));
alter table public.uber_driver_report_imports add constraint uber_driver_report_imports_report_type_check CHECK ((report_type = ANY (ARRAY['trip_activity'::text, 'driver_activity'::text, 'driver_quality'::text])));
alter table public.uber_report_import_log add constraint uber_report_import_log_pkey PRIMARY KEY (id);
alter table public.uber_report_import_log add constraint uber_report_import_log_organization_id_config_revision_file_key UNIQUE (organization_id, config_revision, file_sha256);
alter table public.uber_report_import_log add constraint uber_report_import_log_counts_check CHECK (((jsonb_typeof(counts) = 'object'::text) AND (pg_column_size(counts) <= 16384)));
alter table public.uber_report_import_log add constraint uber_report_import_log_file_sha256_check CHECK ((file_sha256 ~ '^[a-f0-9]{64}$'::text));
alter table public.uber_report_import_log add constraint uber_report_import_log_results_check CHECK (((jsonb_typeof(results) = 'array'::text) AND (pg_column_size(results) <= 8192)));
alter table public.uber_report_settings add constraint uber_report_settings_pkey PRIMARY KEY (id);
alter table public.uber_report_settings add constraint uber_report_settings_check CHECK (((NOT enabled) OR ((organization_id IS NOT NULL) AND (city_agencies <> '{}'::jsonb))));
alter table public.uber_report_settings add constraint uber_report_settings_city_agencies_check CHECK ((jsonb_typeof(city_agencies) = 'object'::text));
alter table public.uber_report_settings add constraint uber_report_settings_collector_state_check CHECK (((jsonb_typeof(collector_state) = 'object'::text) AND (pg_column_size(collector_state) <= 8192)));
alter table public.uber_report_settings add constraint uber_report_settings_csv_timezone_check CHECK (((csv_timezone IS NULL) OR (csv_timezone = ANY (ARRAY['UTC'::text, 'Africa/Casablanca'::text]))));
alter table public.uber_report_settings add constraint uber_report_settings_date_format_check CHECK ((date_format = ANY (ARRAY['dmy'::text, 'ymd'::text, 'mdy'::text])));
alter table public.uber_report_settings add constraint uber_report_settings_id_check CHECK ((id = 1));
alter table public.uber_report_settings add constraint uber_report_settings_last_status_check CHECK ((last_status = ANY (ARRAY['unconfigured'::text, 'ready'::text, 'imported'::text, 'empty'::text, 'error'::text])));
alter table public.uber_report_settings add constraint uber_report_settings_organization_label_check CHECK (((organization_label IS NULL) OR ((organization_label = btrim(organization_label)) AND ((length(organization_label) >= 1) AND (length(organization_label) <= 160)) AND (organization_label !~ '[[:cntrl:]]'::text))));
CREATE INDEX driver_notifications_account_recent ON public.driver_notifications USING btree (account_id, observed_at DESC);
CREATE INDEX driver_portal_sessions_account ON public.driver_portal_sessions USING btree (account_id);
CREATE INDEX driver_reports_account_recent ON public.driver_reports USING btree (account_id, reported_at DESC);
CREATE INDEX driver_reports_moderation ON public.driver_reports USING btree (status, reported_at DESC);
CREATE UNIQUE INDEX fleet_one_open_alert ON public.fleet_alerts USING btree (identity_id) WHERE (status = 'open'::text);
CREATE INDEX fleet_disconnection_alerts_driver ON public.fleet_disconnection_alerts USING btree (driver_id, disconnected_at DESC);
CREATE INDEX fleet_disconnection_alerts_recent ON public.fleet_disconnection_alerts USING btree (disconnected_at DESC, id);
CREATE INDEX fleet_driver_report_period ON public.fleet_driver_report_summaries USING btree (driver_id, source, period_from, period_to);
CREATE UNIQUE INDEX fleet_one_ludy_driver ON public.fleet_drivers USING btree (ludy_driver_code) WHERE (ludy_driver_code IS NOT NULL);
CREATE INDEX fleet_motion_alerts_recent ON public.fleet_motion_alerts USING btree (opened_at DESC);
CREATE INDEX fleet_myclicar_current_driver ON public.fleet_myclicar_contracts USING btree (client_code) WHERE current;
CREATE INDEX fleet_myclicar_current_vehicle ON public.fleet_myclicar_contracts USING btree (vehicle_key) WHERE current;
CREATE INDEX fleet_myclicar_inventory_vehicle ON public.fleet_myclicar_vehicles USING btree (vehicle_key);
CREATE INDEX fleet_observations_history ON public.fleet_observations USING btree (driver_id, source, observed_at);
CREATE INDEX fleet_parking_events_time ON public.fleet_parking_events USING btree (observed_at DESC);
CREATE INDEX fleet_rides_driver_requested ON public.fleet_rides USING btree (driver_id, source, requested_at);
CREATE INDEX fleet_rotation_agency_return ON public.fleet_rotation_contracts USING btree (agency_id, end_at);
CREATE INDEX fleet_rotation_vehicle_time ON public.fleet_rotation_contracts USING btree (vehicle_key, effective_start_at);
CREATE INDEX fleet_source_events_time ON public.fleet_source_events USING btree (source, at);
CREATE INDEX ops_demand_rides_period ON public.ops_demand_rides USING btree (agency_id, started_at);
CREATE INDEX provider_earnings_driver_period ON public.provider_earnings_rows USING btree (driver_code, source, period_start, period_end);
CREATE UNIQUE INDEX provider_earnings_one_provider_row ON public.provider_earnings_rows USING btree (snapshot_id, provider_driver_id) WHERE (provider_driver_id IS NOT NULL);
CREATE INDEX provider_earnings_row_selection ON public.provider_earnings_rows USING btree (source, organization_id, currency, observed_at DESC, snapshot_id) INCLUDE (period_start, period_end, snapshot_revision, coverage_complete, mapping_complete, agency_id, driver_code, mapping_status);
CREATE INDEX provider_earnings_scope_period ON public.provider_earnings_rows USING btree (agency_id, source, period_start, period_end);
CREATE INDEX provider_earnings_snapshot_selection ON public.provider_earnings_snapshots USING btree (source, organization_id, currency, observed_at DESC) INCLUDE (id, period_start, period_end, revision);
CREATE INDEX telemetry_received ON public.telemetry_observations USING btree (received_at, id);
CREATE INDEX telemetry_vehicle_observed ON public.telemetry_observations USING btree (vehicle_key, observed_at, id);
CREATE INDEX uber_driver_report_recent ON public.uber_driver_report_imports USING btree (last_received_at DESC);

-- ----------------------------------------------------------------------------- Clés étrangères
alter table public.desktop_vehicle_live add constraint desktop_vehicle_live_vehicle_key_fkey FOREIGN KEY (vehicle_key) REFERENCES vehicles(key) ON DELETE CASCADE;
alter table public.desktop_worker_devices add constraint desktop_worker_devices_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.desktop_worker_leases add constraint desktop_worker_leases_device_id_fkey FOREIGN KEY (device_id) REFERENCES desktop_worker_devices(id) ON DELETE SET NULL;
alter table public.driver_notifications add constraint driver_notifications_account_id_fkey FOREIGN KEY (account_id) REFERENCES driver_portal_accounts(id) ON DELETE CASCADE;
alter table public.driver_portal_accounts add constraint driver_portal_accounts_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES agencies(id);
alter table public.driver_portal_accounts add constraint driver_portal_accounts_ludy_driver_code_fkey FOREIGN KEY (ludy_driver_code) REFERENCES drivers(code) ON UPDATE CASCADE;
alter table public.driver_portal_sessions add constraint driver_portal_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES driver_portal_accounts(id) ON DELETE CASCADE;
alter table public.driver_reports add constraint driver_reports_account_id_fkey FOREIGN KEY (account_id) REFERENCES driver_portal_accounts(id) ON DELETE CASCADE;
alter table public.driver_reports add constraint driver_reports_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.fleet_alerts add constraint fleet_alerts_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES fleet_drivers(id) ON DELETE CASCADE;
alter table public.fleet_alerts add constraint fleet_alerts_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES fleet_identities(id) ON DELETE CASCADE;
alter table public.fleet_alerts add constraint fleet_alerts_source_fkey FOREIGN KEY (source) REFERENCES fleet_sources(id);
alter table public.fleet_contract_assignment_overrides add constraint fleet_contract_assignment_overrides_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES fleet_myclicar_contracts(external_id) ON DELETE CASCADE;
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES fleet_drivers(id) ON DELETE CASCADE;
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES fleet_identities(id) ON DELETE CASCADE;
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_source_fkey FOREIGN KEY (source) REFERENCES fleet_sources(id);
alter table public.fleet_disconnection_alerts add constraint fleet_disconnection_alerts_vehicle_key_fkey FOREIGN KEY (vehicle_key) REFERENCES vehicles(key) ON DELETE SET NULL;
alter table public.fleet_disconnection_checkpoints add constraint fleet_disconnection_checkpoints_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES fleet_identities(id) ON DELETE CASCADE;
alter table public.fleet_driver_performance_sync add constraint fleet_driver_performance_sync_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES fleet_drivers(id) ON DELETE CASCADE;
alter table public.fleet_driver_performance_sync add constraint fleet_driver_performance_sync_source_fkey FOREIGN KEY (source) REFERENCES fleet_sources(id);
alter table public.fleet_driver_report_summaries add constraint fleet_driver_report_summaries_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES fleet_drivers(id) ON DELETE CASCADE;
alter table public.fleet_drivers add constraint fleet_drivers_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE SET NULL;
alter table public.fleet_drivers add constraint fleet_drivers_ludy_driver_code_fkey FOREIGN KEY (ludy_driver_code) REFERENCES drivers(code) ON DELETE SET NULL;
alter table public.fleet_drivers add constraint fleet_drivers_vehicle_key_fkey FOREIGN KEY (vehicle_key) REFERENCES vehicles(key) ON DELETE SET NULL;
alter table public.fleet_identities add constraint fleet_identities_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES fleet_drivers(id) ON DELETE CASCADE;
alter table public.fleet_identities add constraint fleet_identities_source_fkey FOREIGN KEY (source) REFERENCES fleet_sources(id);
alter table public.fleet_latest add constraint fleet_latest_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES fleet_drivers(id) ON DELETE CASCADE;
alter table public.fleet_latest add constraint fleet_latest_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES fleet_identities(id) ON DELETE CASCADE;
alter table public.fleet_latest add constraint fleet_latest_source_fkey FOREIGN KEY (source) REFERENCES fleet_sources(id);
alter table public.fleet_link_audit add constraint fleet_link_audit_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES fleet_drivers(id) ON DELETE SET NULL;
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES fleet_drivers(id) ON DELETE CASCADE;
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES fleet_identities(id) ON DELETE CASCADE;
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_source_fkey FOREIGN KEY (source) REFERENCES fleet_sources(id);
alter table public.fleet_motion_alerts add constraint fleet_motion_alerts_vehicle_key_fkey FOREIGN KEY (vehicle_key) REFERENCES vehicles(key) ON DELETE CASCADE;
alter table public.fleet_motion_checkpoints add constraint fleet_motion_checkpoints_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES fleet_identities(id) ON DELETE CASCADE;
alter table public.fleet_motion_checkpoints add constraint fleet_motion_checkpoints_source_fkey FOREIGN KEY (source) REFERENCES fleet_sources(id);
alter table public.fleet_motion_checkpoints add constraint fleet_motion_checkpoints_vehicle_key_fkey FOREIGN KEY (vehicle_key) REFERENCES vehicles(key) ON DELETE CASCADE;
alter table public.fleet_myclicar_agencies add constraint fleet_myclicar_agencies_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE SET NULL;
alter table public.fleet_myclicar_contracts add constraint fleet_myclicar_contracts_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE SET NULL;
alter table public.fleet_myclicar_contracts add constraint fleet_myclicar_contracts_vehicle_key_fkey FOREIGN KEY (vehicle_key) REFERENCES vehicles(key) ON DELETE SET NULL;
alter table public.fleet_myclicar_vehicles add constraint fleet_myclicar_vehicles_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE SET NULL;
alter table public.fleet_myclicar_vehicles add constraint fleet_myclicar_vehicles_vehicle_key_fkey FOREIGN KEY (vehicle_key) REFERENCES vehicles(key) ON DELETE SET NULL;
alter table public.fleet_observations add constraint fleet_observations_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES fleet_drivers(id) ON DELETE CASCADE;
alter table public.fleet_observations add constraint fleet_observations_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES fleet_identities(id) ON DELETE CASCADE;
alter table public.fleet_observations add constraint fleet_observations_source_fkey FOREIGN KEY (source) REFERENCES fleet_sources(id);
alter table public.fleet_parking_events add constraint fleet_parking_events_vehicle_key_fkey FOREIGN KEY (vehicle_key) REFERENCES vehicles(key);
alter table public.fleet_parking_events add constraint fleet_parking_events_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES fleet_parking_zones(id);
alter table public.fleet_parking_state add constraint fleet_parking_state_vehicle_key_fkey FOREIGN KEY (vehicle_key) REFERENCES vehicles(key) ON DELETE CASCADE;
alter table public.fleet_parking_state add constraint fleet_parking_state_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES fleet_parking_zones(id);
alter table public.fleet_parking_zones add constraint fleet_parking_zones_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES agencies(id);
alter table public.fleet_parking_zones add constraint fleet_parking_zones_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.fleet_provider_vehicles add constraint fleet_provider_vehicles_source_fkey FOREIGN KEY (source) REFERENCES fleet_sources(id);
alter table public.fleet_rides add constraint fleet_rides_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES fleet_drivers(id) ON DELETE SET NULL;
alter table public.fleet_rides add constraint fleet_rides_source_fkey FOREIGN KEY (source) REFERENCES fleet_sources(id);
alter table public.fleet_rotation_contracts add constraint fleet_rotation_contracts_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE SET NULL;
alter table public.fleet_rotation_contracts add constraint fleet_rotation_contracts_vehicle_key_fkey FOREIGN KEY (vehicle_key) REFERENCES vehicles(key) ON DELETE SET NULL;
alter table public.fleet_source_events add constraint fleet_source_events_source_fkey FOREIGN KEY (source) REFERENCES fleet_sources(id);
alter table public.ops_demand_imports add constraint ops_demand_imports_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES agencies(id);
alter table public.ops_demand_rides add constraint ops_demand_rides_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES agencies(id);
alter table public.ops_demand_rides add constraint ops_demand_rides_import_id_fkey FOREIGN KEY (import_id) REFERENCES ops_demand_imports(id);
alter table public.ops_event_reviews add constraint ops_event_reviews_event_id_fkey FOREIGN KEY (event_id) REFERENCES ops_events(id);
alter table public.ops_event_reviews add constraint ops_event_reviews_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);
alter table public.ops_events add constraint ops_events_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);
alter table public.ops_events add constraint ops_events_source_id_fkey FOREIGN KEY (source_id) REFERENCES ops_event_sources(id);
alter table public.ops_fuel_checkpoints add constraint ops_fuel_checkpoints_vehicle_key_fkey FOREIGN KEY (vehicle_key) REFERENCES vehicles(key) ON DELETE CASCADE;
alter table public.ops_rush_rules add constraint ops_rush_rules_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES agencies(id);
alter table public.provider_earnings_rows add constraint provider_earnings_rows_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES provider_earnings_snapshots(id) ON DELETE RESTRICT;


-- ----------------------------------------------------------------------------- Fonctions de Ludy remplacées par l'application de bureau
CREATE OR REPLACE FUNCTION public.bump_usage(p_kind text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  insert into usage_daily (day, kind, n) values ((now() at time zone 'Africa/Casablanca')::date, p_kind, 1)
  on conflict (day, kind) do update set n = usage_daily.n + 1
$function$;

CREATE OR REPLACE FUNCTION public.hr_clock_do(p_kind text, p_birth date DEFAULT NULL::date, p_client text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e public.hr_employees; st text; n int;
begin
  select * into e from public.hr_employees where user_id = auth.uid() and (left_on is null or left_on > current_date) and pointage;
  if e.id is null then return jsonb_build_object('ok', false, 'error', 'Pointage non activé pour ce compte'); end if;
  if p_kind not in ('in', 'pause', 'resume', 'out') then return jsonb_build_object('ok', false, 'error', 'Action inconnue'); end if;
  st := public.hr_state(e.id) ->> 'state';
  if p_kind = 'in' then
    -- ouverture de Ludy : date de naissance obligatoire, 5 essais manqués en 15 minutes au plus
    select count(*) into n from public.hr_clock where employee_id = e.id and kind = 'fail' and at > now() - interval '15 minutes';
    if n >= 5 then return jsonb_build_object('ok', false, 'error', 'Trop d''essais : réessayez dans 15 minutes'); end if;
    if e.birth_date is null then return jsonb_build_object('ok', false, 'error', 'Date de naissance absente de la fiche : demandez à l''administrateur de la renseigner'); end if;
    if p_birth is distinct from e.birth_date then
      insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'fail', left(p_client, 80));
      return jsonb_build_object('ok', false, 'error', 'Date de naissance incorrecte');
    end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), case when st = 'off' then 'in' else 'session' end, left(p_client, 80));
  elsif p_kind = 'pause' then
    if st <> 'on' then return jsonb_build_object('ok', false, 'error', 'Pause possible seulement en service'); end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'pause', left(p_client, 80));
  elsif p_kind = 'resume' then
    if st <> 'pause' then return jsonb_build_object('ok', false, 'error', 'Aucune pause en cours'); end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'resume', left(p_client, 80));
  else
    if st = 'off' then return jsonb_build_object('ok', false, 'error', 'Aucune journée en cours'); end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'out', left(p_client, 80));
  end if;
  return jsonb_build_object('ok', true) || public.hr_me();
end $function$;

CREATE OR REPLACE FUNCTION public.plan_can_edit(p_agency bigint, p_week date DEFAULT NULL::date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select is_admin() or (
    my_role() = 'manager' and p_agency = any(my_agency_ids())
    and coalesce((select value from params where key = 'planManagersEdit'), 'oui') <> 'non'
    and (p_week is null or not exists (select 1 from plan_weeks w where w.agency_id = p_agency and w.week = p_week and w.locked)))
$function$;

CREATE OR REPLACE FUNCTION public.plan_driver_in(p_code text, p_agency bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select is_admin() or (coalesce((select agency_id from driver_roster where driver_code = p_code), (select agency_id from drivers where code = p_code), p_agency) = p_agency)
$function$;

CREATE OR REPLACE FUNCTION public.refresh_drivers()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare news jsonb; dupes jsonb;
begin
  if (select value from public.params where key='environment') is distinct from 'production' then raise exception 'Production marker required';end if;
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  create temp table _d on commit drop as
  with c as (select client_code code, trim(coalesce(name, '')) nm, start_at, phone, email, num from contracts
              where coalesce(client_code, '') <> '' and start_at is not null),
  agg as (select code, count(*)::int n, min(start_at) first_c, max(start_at) last_c from c group by code),
  lst as (select distinct on (code) code, nm, phone, email from c order by code, start_at desc, num desc),
  oth as (select c.code, string_agg(distinct c.nm, ' / ' order by c.nm) others from c join lst using (code) where c.nm <> '' and c.nm <> lst.nm group by c.code)
  select a.code, l.nm as name, coalesce(o.others, '') other_names, regexp_replace(coalesce(l.phone, ''), '^''', '') phone, coalesce(l.email, '') email,
         a.first_c, a.last_c, a.n, d.code is null as is_new,
         case when d.code is null then 'NOUVEAU' when d.status = 'NOUVEAU' and d.detected_at < now() - interval '7 days' then 'ACTIF' else coalesce(nullif(d.status, ''), 'ACTIF') end status,
         coalesce(d.detected_at, now()) detected_at, coalesce(d.note, '') note
    from agg a join lst l using (code) left join oth o using (code) left join drivers d on d.code = a.code;
  update _d set note = case when note = '' then '' else note || ' | ' end || 'Doublon possible : ' || g.codes
    from (select norm_name(name) k, string_agg(code, ', ' order by code) codes from _d group by 1 having count(*) > 1) g
   where norm_name(_d.name) = g.k and position('Doublon' in _d.note) = 0;
  select coalesce(jsonb_agg(name || ' (' || code || ')' order by name), '[]') into news from _d where is_new;
  select coalesce(jsonb_agg(codes), '[]') into dupes from (select string_agg(code, ' = ' order by code) codes from _d group by norm_name(name) having count(*) > 1) x;
  delete from drivers d where d.code not in (select code from _d) and d.source='contrats'
    and not exists(select 1 from public.fleet_drivers f where f.ludy_driver_code=d.code)
    and not exists(select 1 from public.driver_portal_accounts a where a.ludy_driver_code=d.code);
  insert into drivers (code, name, other_names, phone, email, first_contract, last_contract, n_contracts, status, detected_at, note)
  select code, name, other_names, phone, email, first_c, last_c, n, status, detected_at, note from _d
  on conflict (code) do update set
    name = case when drivers.source = 'manuel' and coalesce(drivers.name, '') <> '' then drivers.name else excluded.name end,
    other_names = excluded.other_names,
    phone = case when drivers.source = 'manuel' and coalesce(drivers.phone, '') <> '' then drivers.phone else excluded.phone end,
    email = case when drivers.source = 'manuel' and coalesce(drivers.email, '') <> '' then drivers.email else excluded.email end,
    first_contract = excluded.first_contract, last_contract = excluded.last_contract, n_contracts = excluded.n_contracts,
    status = excluded.status, note = excluded.note
    where drivers.source='contrats';
  -- agence d'un chauffeur qui n'en a pas : celle du véhicule de son dernier contrat (un chauffeur rattaché n'est jamais déplacé)
  update drivers d set agency_id = v.agency_id
    from (select distinct on (c.client_code) c.client_code, ve.agency_id from contracts c join vehicles ve on ve.key = c.vehicle_key
           where coalesce(c.client_code, '') <> '' and ve.agency_id is not null order by c.client_code, c.start_at desc nulls last, c.num desc) v
   where d.code = v.client_code and d.agency_id is null and d.source='contrats';
  -- compte Uber : même téléphone (9 derniers chiffres), sinon même nom (mots dans n'importe quel ordre) ; seulement un candidat unique,
  -- jamais un compte déjà relié à un autre chauffeur, jamais un chauffeur déjà relié
  if to_regclass('public.uber_drivers') is not null then
    with dp as (select code, right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9) p, name_key(name) k from drivers where uber_uuid is null and source='contrats'),
    up as (select uuid, right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9) p, name_key(name) k from uber_drivers u
            where not exists (select 1 from drivers x where x.uber_uuid = u.uuid)),
    byp as (select dp.code, min(up.uuid) uuid, count(*) n from dp join up on length(dp.p) = 9 and dp.p = up.p group by dp.code),
    byn as (select dp.code, min(up.uuid) uuid, count(*) n from dp join up on dp.k <> '' and dp.k = up.k group by dp.code),
    cand as (select dp.code, coalesce((select b.uuid from byp b where b.code = dp.code and b.n = 1), (select b.uuid from byn b where b.code = dp.code and b.n = 1)) uuid from dp),
    uniq as (select code, uuid from cand where uuid is not null and uuid in (select uuid from cand where uuid is not null group by uuid having count(*) = 1))
    update drivers d set uber_uuid = uniq.uuid from uniq where d.code = uniq.code and d.uber_uuid is null;
  end if;
  drop table _d;
  return jsonb_build_object('new', news, 'dupes', dupes);
end $function$;

CREATE OR REPLACE FUNCTION public.usage_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare st jsonb := '{}'::jsonb; m date := date_trunc('month', now() at time zone 'Africa/Casablanca')::date;
begin
  if not (is_admin() or coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role') then
    raise exception 'réservé à l''administrateur';
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'select coalesce(jsonb_object_agg(bucket_id, mb), ''{}''::jsonb) from (select bucket_id, round(sum(coalesce((metadata->>''size'')::bigint, 0)) / 1048576.0, 1) mb
      from storage.objects group by bucket_id) x' into st;
  end if;
  return jsonb_build_object(
    'db_mb', round(pg_database_size(current_database()) / 1048576.0, 1),
    'storage_mb', st,
    'live_month', (select coalesce(sum(n), 0) from usage_daily where kind = 'live' and day >= m),
    'live_since', (select min(day) from usage_daily where kind = 'live' and day >= m),
    'live_days', (select count(*) from usage_daily where kind = 'live' and day >= m),
    'month', m);
end $function$;

-- ----------------------------------------------------------------------------- Temps réel
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.revenue_refresh;
  end if;
end $$;

-- ----------------------------------------------------------------------------- Déclencheurs
CREATE TRIGGER revenue_refresh_delete AFTER DELETE ON public.bolt_sessions REFERENCING OLD TABLE AS old_revenue_rows FOR EACH STATEMENT EXECUTE FUNCTION revenue_refresh_after_statement();
CREATE TRIGGER revenue_refresh_insert AFTER INSERT ON public.bolt_sessions REFERENCING NEW TABLE AS new_revenue_rows FOR EACH STATEMENT EXECUTE FUNCTION revenue_refresh_after_statement();
CREATE TRIGGER revenue_refresh_update AFTER UPDATE ON public.bolt_sessions REFERENCING OLD TABLE AS old_revenue_rows NEW TABLE AS new_revenue_rows FOR EACH STATEMENT EXECUTE FUNCTION revenue_refresh_after_statement();
CREATE TRIGGER revenue_refresh_delete AFTER DELETE ON public.cash_moves REFERENCING OLD TABLE AS old_revenue_rows FOR EACH STATEMENT EXECUTE FUNCTION revenue_refresh_after_statement();
CREATE TRIGGER revenue_refresh_insert AFTER INSERT ON public.cash_moves REFERENCING NEW TABLE AS new_revenue_rows FOR EACH STATEMENT EXECUTE FUNCTION revenue_refresh_after_statement();
CREATE TRIGGER revenue_refresh_update AFTER UPDATE ON public.cash_moves REFERENCING OLD TABLE AS old_revenue_rows NEW TABLE AS new_revenue_rows FOR EACH STATEMENT EXECUTE FUNCTION revenue_refresh_after_statement();
CREATE TRIGGER desktop_vehicle_live_stamp BEFORE INSERT OR UPDATE ON public.desktop_vehicle_live FOR EACH ROW EXECUTE FUNCTION desktop_vehicle_live_stamp();
CREATE TRIGGER fleet_preserve_disconnections_before_delete BEFORE DELETE ON public.fleet_drivers FOR EACH ROW EXECUTE FUNCTION fleet_preserve_disconnections_on_merge();
CREATE TRIGGER fleet_parking_zone_reset BEFORE UPDATE ON public.fleet_parking_zones FOR EACH ROW EXECUTE FUNCTION fleet_parking_zone_reset();
CREATE TRIGGER ludy_desktop_geotab_live_guard BEFORE INSERT OR DELETE OR UPDATE ON public.live_status FOR EACH ROW EXECUTE FUNCTION ludy_desktop_geotab_legacy_guard();
alter table public.live_status disable trigger ludy_desktop_geotab_live_guard;   -- désactivé en production
CREATE TRIGGER telemetry_archive_immutable BEFORE DELETE OR UPDATE ON public.telemetry_observations FOR EACH STATEMENT EXECUTE FUNCTION telemetry_archive_immutable();
CREATE TRIGGER revenue_refresh_delete AFTER DELETE ON public.uber_payments REFERENCING OLD TABLE AS old_revenue_rows FOR EACH STATEMENT EXECUTE FUNCTION revenue_refresh_after_statement();
CREATE TRIGGER revenue_refresh_insert AFTER INSERT ON public.uber_payments REFERENCING NEW TABLE AS new_revenue_rows FOR EACH STATEMENT EXECUTE FUNCTION revenue_refresh_after_statement();
CREATE TRIGGER revenue_refresh_update AFTER UPDATE ON public.uber_payments REFERENCING OLD TABLE AS old_revenue_rows NEW TABLE AS new_revenue_rows FOR EACH STATEMENT EXECUTE FUNCTION revenue_refresh_after_statement();
CREATE TRIGGER ludy_desktop_geotab_vehicle_guard BEFORE INSERT OR DELETE OR UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION ludy_desktop_geotab_legacy_guard();
alter table public.vehicles disable trigger ludy_desktop_geotab_vehicle_guard;   -- désactivé en production

-- ----------------------------------------------------------------------------- Sécurité des lignes et droits
alter table public.desktop_vehicle_live enable row level security;
alter table public.desktop_worker_devices enable row level security;
alter table public.desktop_worker_leases enable row level security;
alter table public.driver_notifications enable row level security;
alter table public.driver_portal_accounts enable row level security;
alter table public.driver_portal_sessions enable row level security;
alter table public.driver_reports enable row level security;
alter table public.fleet_alerts enable row level security;
alter table public.fleet_contract_assignment_overrides enable row level security;
alter table public.fleet_disconnection_alerts enable row level security;
alter table public.fleet_disconnection_checkpoints enable row level security;
alter table public.fleet_driver_performance_sync enable row level security;
alter table public.fleet_driver_report_summaries enable row level security;
alter table public.fleet_drivers enable row level security;
alter table public.fleet_identities enable row level security;
alter table public.fleet_inventory_sync enable row level security;
alter table public.fleet_latest enable row level security;
alter table public.fleet_link_audit enable row level security;
alter table public.fleet_motion_alerts enable row level security;
alter table public.fleet_motion_checkpoints enable row level security;
alter table public.fleet_myclicar_agencies enable row level security;
alter table public.fleet_myclicar_contracts enable row level security;
alter table public.fleet_myclicar_vehicles enable row level security;
alter table public.fleet_observations enable row level security;
alter table public.fleet_parking_events enable row level security;
alter table public.fleet_parking_state enable row level security;
alter table public.fleet_parking_zones enable row level security;
alter table public.fleet_provider_vehicles enable row level security;
alter table public.fleet_rides enable row level security;
alter table public.fleet_rotation_contracts enable row level security;
alter table public.fleet_rotation_sync enable row level security;
alter table public.fleet_settings enable row level security;
alter table public.fleet_source_events enable row level security;
alter table public.fleet_sources enable row level security;
alter table public.ops_demand_imports enable row level security;
alter table public.ops_demand_rides enable row level security;
alter table public.ops_event_reviews enable row level security;
alter table public.ops_event_sources enable row level security;
alter table public.ops_events enable row level security;
alter table public.ops_fuel_checkpoints enable row level security;
alter table public.ops_fuel_reference_runs enable row level security;
alter table public.ops_fuel_settings enable row level security;
alter table public.ops_rush_rules enable row level security;
alter table public.provider_earnings_rows enable row level security;
alter table public.provider_earnings_snapshots enable row level security;
alter table public.revenue_refresh enable row level security;
alter table public.telemetry_observations enable row level security;
alter table public.uber_driver_report_imports enable row level security;
alter table public.uber_report_import_log enable row level security;
alter table public.uber_report_settings enable row level security;
create policy read_vehicle on public.desktop_vehicle_live as permissive for select to authenticated using ((EXISTS ( SELECT 1
   FROM vehicles v
  WHERE (v.key = desktop_vehicle_live.vehicle_key))));
create policy read_scope on public.fleet_alerts as permissive for select to authenticated using (fleet_can_read(driver_id));
create policy read_admin on public.fleet_contract_assignment_overrides as permissive for select to authenticated using (is_admin());
create policy read_scope on public.fleet_disconnection_alerts as permissive for select to authenticated using (fleet_can_read(driver_id));
create policy staff_driver_scope on public.fleet_driver_performance_sync as permissive for select to authenticated using (((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])) AND fleet_can_read(driver_id)));
create policy staff_driver_scope on public.fleet_driver_report_summaries as permissive for select to authenticated using (((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])) AND fleet_can_read(driver_id)));
create policy read_scope on public.fleet_drivers as permissive for select to authenticated using (fleet_can_read(id));
create policy read_scope on public.fleet_identities as permissive for select to authenticated using (fleet_can_read(driver_id));
create policy read_admin on public.fleet_inventory_sync as permissive for select to authenticated using (is_admin());
create policy read_scope on public.fleet_latest as permissive for select to authenticated using (fleet_can_read(driver_id));
create policy read_admin on public.fleet_link_audit as permissive for select to authenticated using (is_admin());
create policy read_scope on public.fleet_motion_alerts as permissive for select to authenticated using ((fleet_can_read(driver_id) AND (is_admin() OR (vehicle_key = ANY (my_vehicle_keys())))));
create policy read_scope on public.fleet_myclicar_agencies as permissive for select to authenticated using (((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])) AND (is_admin() OR (agency_id = ANY (my_agency_ids())))));
create policy read_scope on public.fleet_myclicar_contracts as permissive for select to authenticated using (((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])) AND (is_admin() OR (agency_id = ANY (my_agency_ids())))));
create policy read_scope on public.fleet_myclicar_vehicles as permissive for select to authenticated using (((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])) AND (is_admin() OR (agency_id = ANY (my_agency_ids())))));
create policy read_scope on public.fleet_observations as permissive for select to authenticated using (fleet_can_read(driver_id));
create policy read_vehicle on public.fleet_parking_events as permissive for select to authenticated using ((is_admin() OR (vehicle_key = ANY (my_vehicle_keys()))));
create policy read_vehicle on public.fleet_parking_state as permissive for select to authenticated using ((is_admin() OR (vehicle_key = ANY (my_vehicle_keys()))));
create policy read_staff on public.fleet_parking_zones as permissive for select to authenticated using ((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])));
create policy read_admin on public.fleet_provider_vehicles as permissive for select to authenticated using (is_admin());
create policy read_scope on public.fleet_rides as permissive for select to authenticated using (fleet_can_read(driver_id));
create policy read_scope on public.fleet_rotation_contracts as permissive for select to authenticated using (((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])) AND (is_admin() OR (agency_id = ANY (my_agency_ids())))));
create policy read_staff on public.fleet_rotation_sync as permissive for select to authenticated using ((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])));
create policy read_validated on public.fleet_settings as permissive for select to authenticated using ((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])));
create policy read_validated on public.fleet_source_events as permissive for select to authenticated using ((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])));
create policy read_admin on public.fleet_sources as permissive for select to authenticated using (is_admin());
create policy read_scope on public.ops_demand_imports as permissive for select to authenticated using (ops_can_read_agency(agency_id));
create policy read_scope on public.ops_demand_rides as permissive for select to authenticated using (ops_can_read_agency(agency_id));
create policy staff_read on public.ops_event_reviews as permissive for select to authenticated using ((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])));
create policy staff_read on public.ops_event_sources as permissive for select to authenticated using ((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])));
create policy staff_read on public.ops_events as permissive for select to authenticated using ((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])));
create policy staff_read on public.ops_fuel_settings as permissive for select to authenticated using ((my_role() = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])));
create policy read_scope on public.ops_rush_rules as permissive for select to authenticated using (ops_can_read_agency(agency_id));
create policy provider_earnings_driver_scope on public.provider_earnings_rows as permissive for select to authenticated using ((( SELECT is_admin() AS is_admin) OR ((my_role() = 'manager'::text) AND (mapping_status = 'confirmed'::text) AND (agency_id = ANY (( SELECT my_agency_ids() AS my_agency_ids)::bigint[])))));
create policy provider_earnings_fleet_admin on public.provider_earnings_snapshots as permissive for select to authenticated using (( SELECT is_admin() AS is_admin));
create policy revenue_refresh_read on public.revenue_refresh as permissive for select to authenticated using ((( SELECT is_admin() AS is_admin) OR ((agency_id > 0) AND (my_role() = 'manager'::text) AND (agency_id = ANY (( SELECT my_agency_ids() AS my_agency_ids)::bigint[])))));
create policy telemetry_observations_read on public.telemetry_observations as permissive for select to authenticated using ((( SELECT is_admin() AS is_admin) OR ((my_role() = 'manager'::text) AND (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.key = telemetry_observations.vehicle_key) AND (v.agency_id = ANY (( SELECT my_agency_ids() AS my_agency_ids)::bigint[]))))))));
revoke all on public.desktop_vehicle_live from anon, authenticated, service_role;
revoke all on public.desktop_worker_devices from anon, authenticated, service_role;
revoke all on public.desktop_worker_leases from anon, authenticated, service_role;
revoke all on public.driver_notifications from anon, authenticated, service_role;
revoke all on public.driver_portal_accounts from anon, authenticated, service_role;
revoke all on public.driver_portal_sessions from anon, authenticated, service_role;
revoke all on public.driver_reports from anon, authenticated, service_role;
revoke all on public.fleet_alerts from anon, authenticated, service_role;
revoke all on public.fleet_contract_assignment_overrides from anon, authenticated, service_role;
revoke all on public.fleet_disconnection_alerts from anon, authenticated, service_role;
revoke all on public.fleet_disconnection_checkpoints from anon, authenticated, service_role;
revoke all on public.fleet_driver_performance_sync from anon, authenticated, service_role;
revoke all on public.fleet_driver_report_summaries from anon, authenticated, service_role;
revoke all on public.fleet_drivers from anon, authenticated, service_role;
revoke all on public.fleet_identities from anon, authenticated, service_role;
revoke all on public.fleet_inventory_sync from anon, authenticated, service_role;
revoke all on public.fleet_latest from anon, authenticated, service_role;
revoke all on public.fleet_link_audit from anon, authenticated, service_role;
revoke all on public.fleet_motion_alerts from anon, authenticated, service_role;
revoke all on public.fleet_motion_checkpoints from anon, authenticated, service_role;
revoke all on public.fleet_myclicar_agencies from anon, authenticated, service_role;
revoke all on public.fleet_myclicar_contracts from anon, authenticated, service_role;
revoke all on public.fleet_myclicar_vehicles from anon, authenticated, service_role;
revoke all on public.fleet_observations from anon, authenticated, service_role;
revoke all on public.fleet_parking_events from anon, authenticated, service_role;
revoke all on public.fleet_parking_state from anon, authenticated, service_role;
revoke all on public.fleet_parking_zones from anon, authenticated, service_role;
revoke all on public.fleet_provider_vehicles from anon, authenticated, service_role;
revoke all on public.fleet_rides from anon, authenticated, service_role;
revoke all on public.fleet_rotation_contracts from anon, authenticated, service_role;
revoke all on public.fleet_rotation_sync from anon, authenticated, service_role;
revoke all on public.fleet_settings from anon, authenticated, service_role;
revoke all on public.fleet_source_events from anon, authenticated, service_role;
revoke all on public.fleet_sources from anon, authenticated, service_role;
revoke all on public.ops_demand_imports from anon, authenticated, service_role;
revoke all on public.ops_demand_rides from anon, authenticated, service_role;
revoke all on public.ops_event_reviews from anon, authenticated, service_role;
revoke all on public.ops_event_sources from anon, authenticated, service_role;
revoke all on public.ops_events from anon, authenticated, service_role;
revoke all on public.ops_fuel_checkpoints from anon, authenticated, service_role;
revoke all on public.ops_fuel_reference_runs from anon, authenticated, service_role;
revoke all on public.ops_fuel_settings from anon, authenticated, service_role;
revoke all on public.ops_rush_rules from anon, authenticated, service_role;
revoke all on public.provider_earnings_rows from anon, authenticated, service_role;
revoke all on public.provider_earnings_snapshots from anon, authenticated, service_role;
revoke all on public.revenue_refresh from anon, authenticated, service_role;
revoke all on public.telemetry_observations from anon, authenticated, service_role;
revoke all on public.uber_driver_report_imports from anon, authenticated, service_role;
revoke all on public.uber_report_import_log from anon, authenticated, service_role;
revoke all on public.uber_report_settings from anon, authenticated, service_role;
grant select on public.desktop_vehicle_live to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.driver_notifications to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.driver_portal_accounts to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.driver_portal_sessions to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.driver_reports to service_role;
grant select on public.fleet_alerts to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_alerts to service_role;
grant select on public.fleet_contract_assignment_overrides to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_contract_assignment_overrides to service_role;
grant select on public.fleet_disconnection_alerts to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_disconnection_alerts to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_disconnection_checkpoints to service_role;
grant select on public.fleet_driver_performance_sync to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_driver_performance_sync to service_role;
grant select on public.fleet_driver_report_summaries to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_driver_report_summaries to service_role;
grant select on public.fleet_drivers to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_drivers to service_role;
grant select on public.fleet_identities to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_identities to service_role;
grant select on public.fleet_inventory_sync to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_inventory_sync to service_role;
grant select on public.fleet_latest to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_latest to service_role;
grant select on public.fleet_link_audit to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_link_audit to service_role;
grant select on public.fleet_motion_alerts to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_motion_alerts to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_motion_checkpoints to service_role;
grant select on public.fleet_myclicar_agencies to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_myclicar_agencies to service_role;
grant select on public.fleet_myclicar_contracts to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_myclicar_contracts to service_role;
grant select on public.fleet_myclicar_vehicles to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_myclicar_vehicles to service_role;
grant select on public.fleet_observations to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_observations to service_role;
grant select on public.fleet_parking_events to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_parking_events to service_role;
grant select on public.fleet_parking_state to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_parking_state to service_role;
grant select on public.fleet_parking_zones to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_parking_zones to service_role;
grant select on public.fleet_provider_vehicles to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_provider_vehicles to service_role;
grant select on public.fleet_rides to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_rides to service_role;
grant select on public.fleet_rotation_contracts to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_rotation_contracts to service_role;
grant select on public.fleet_rotation_sync to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_rotation_sync to service_role;
grant select on public.fleet_settings to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_settings to service_role;
grant select on public.fleet_source_events to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_source_events to service_role;
grant select on public.fleet_sources to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.fleet_sources to service_role;
grant select on public.ops_demand_imports to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.ops_demand_imports to service_role;
grant select on public.ops_demand_rides to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.ops_demand_rides to service_role;
grant select on public.ops_event_reviews to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.ops_event_reviews to service_role;
grant select on public.ops_event_sources to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.ops_event_sources to service_role;
grant select on public.ops_events to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.ops_events to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.ops_fuel_checkpoints to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.ops_fuel_reference_runs to service_role;
grant select on public.ops_fuel_settings to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.ops_fuel_settings to service_role;
grant select on public.ops_rush_rules to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.ops_rush_rules to service_role;
grant select on public.provider_earnings_rows to authenticated;
grant select on public.provider_earnings_rows to service_role;
grant select on public.provider_earnings_snapshots to authenticated;
grant select on public.provider_earnings_snapshots to service_role;
grant select on public.revenue_refresh to authenticated;
grant select on public.telemetry_observations to authenticated;
grant select on public.telemetry_observations to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.uber_driver_report_imports to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.uber_report_import_log to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.uber_report_settings to service_role;
