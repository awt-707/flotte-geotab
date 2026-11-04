-- Prepared desktop-worker control plane. Install only after reviewing the target
-- schema and its business RPC variants. This is NOT a staging migration and does
-- not change params.environment, JWT claims, RLS policies, or any financial row.
-- Existing staging-only business RPCs deliberately keep their staging guards;
-- they must receive separately reviewed production variants before promotion.
-- Worker writes use one workspace-wide lease. Locks and expiry are checked in
-- the SAME transaction as each operation. Provider-side work must also stop on
-- lease loss; PostgreSQL fencing cannot cancel a request already sent externally.
-- Apply as the schema owner in a transaction. No service-role key belongs on a PC.

create schema if not exists desktop_worker_private;
revoke all on schema desktop_worker_private from public,anon,authenticated,service_role;

create table public.desktop_worker_devices (
 id uuid primary key,
 owner_id uuid not null references auth.users(id) on delete cascade,
 label text not null check(char_length(label) between 1 and 120 and label !~ '[[:cntrl:]]'),
 enabled boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),
 approved_at timestamptz,
 updated_at timestamptz not null default clock_timestamp()
);
create table public.desktop_worker_leases (
 scope text primary key check(scope='workspace'),
 device_id uuid references public.desktop_worker_devices(id) on delete set null,
 fence bigint not null default 0 check(fence between 0 and 9007199254740991),
 expires_at timestamptz not null default '-infinity',
 updated_at timestamptz not null default clock_timestamp()
);
insert into public.desktop_worker_leases(scope) values('workspace');
alter table public.desktop_worker_devices enable row level security;
alter table public.desktop_worker_leases enable row level security;
revoke all on public.desktop_worker_devices,public.desktop_worker_leases from public,anon,authenticated,service_role;
-- No client table policy: access is exclusively through the checked RPCs below.

create function desktop_worker_private.admin_user() returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();r text;
begin
 if uid is null or auth.role() is distinct from 'authenticated' then
  raise exception using errcode='42501',message='Desktop administrator session required';end if;
 -- Retain a row lock so a role revocation cannot race a privileged write.
 select p.role into r from public.profiles p where p.user_id=uid for share;
 if r is distinct from 'admin' or public.is_admin() is distinct from true then
  raise exception using errcode='42501',message='Desktop administrator required';end if;
 return uid;
end $$;

create function desktop_worker_private.device(p_device_id uuid,p_write boolean)
returns public.desktop_worker_devices language plpgsql security definer set search_path='' as $$
declare uid uuid:=desktop_worker_private.admin_user();d public.desktop_worker_devices;
begin
 select * into d from public.desktop_worker_devices where id=p_device_id for share;
 if not found or d.owner_id<>uid or (p_write and not d.enabled) then
  raise exception using errcode='42501',message='Desktop device unavailable';end if;
 return d;
end $$;

create function desktop_worker_private.state(p_device_id uuid) returns jsonb
language sql security definer set search_path='' as $$
 select jsonb_build_object('version',1,'device',jsonb_build_object('id',d.id,'enabled',d.enabled,'owner',true),
  'lease',jsonb_build_object('scope',l.scope,'fence',l.fence,'expires_at',case when isfinite(l.expires_at) then l.expires_at else null end,
   'owned',l.device_id=d.id and l.expires_at>clock_timestamp() and d.enabled))
 from public.desktop_worker_devices d cross join public.desktop_worker_leases l where d.id=p_device_id and l.scope='workspace'
$$;

create function public.desktop_worker_register(p_device_id uuid,p_label text,p_enabled boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
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
end $$;

create function public.desktop_worker_status(p_device_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin perform desktop_worker_private.device(p_device_id,false);return desktop_worker_private.state(p_device_id);end $$;

create function public.desktop_worker_claim(p_device_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
end $$;

create function public.desktop_worker_renew(p_device_id uuid,p_fence bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare lease public.desktop_worker_leases;at timestamptz;
begin
 perform desktop_worker_private.device(p_device_id,true);
 select * into strict lease from public.desktop_worker_leases where scope='workspace' for update;
 at:=clock_timestamp();
 if p_fence is null or lease.device_id is distinct from p_device_id or lease.fence<>p_fence or lease.expires_at<=at then
  raise exception using errcode='55000',message='Desktop lease lost';end if;
 update public.desktop_worker_leases set expires_at=at+interval '90 seconds',updated_at=at where scope='workspace';
 return desktop_worker_private.state(p_device_id);
end $$;

create function public.desktop_worker_release(p_device_id uuid,p_fence bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare lease public.desktop_worker_leases;
begin
 perform desktop_worker_private.device(p_device_id,false);
 select * into strict lease from public.desktop_worker_leases where scope='workspace' for update;
 if p_fence is null or lease.device_id is distinct from p_device_id or lease.fence<>p_fence then
  raise exception using errcode='55000',message='Desktop lease lost';end if;
 update public.desktop_worker_leases set device_id=null,expires_at='-infinity',updated_at=clock_timestamp() where scope='workspace';
 return jsonb_build_object('version',1,'released',true);
end $$;

-- Frozen column lists: a later schema addition never becomes exposed implicitly.
-- Auth, profiles, jobs, administrative settings mutations and credentials are
-- absent. params is further restricted to five non-secret scheduling keys.
create function desktop_worker_private.read_columns(p_resource text) returns text[]
language sql immutable set search_path='' as $$ select case p_resource
 when 'desktop_vehicle_live' then array['vehicle_key','data','observed_at']::text[]
 when 'driver_portal_accounts' then array['id','ludy_driver_code','active']::text[]
 when 'driver_notifications' then array['id','account_id','event_key','kind','title','message','observed_at','created_at','acknowledged_at','evidence']::text[]
 when 'agencies' then array['id','name','city']::text[]
 when 'drivers' then array['code','name','other_names','agency_id','status','source','uber_uuid']::text[]
 when 'fleet_alerts' then array['id','driver_id','identity_id','source','kind','status','opened_at','observed_since','resolved_at','last_seen_at','threshold_s','rule']::text[]
 when 'fleet_contract_assignment_overrides' then array['contract_id','client_code','vehicle_key','effective_start_at','observed_at','evidence','latest_conflict_at']::text[]
 when 'fleet_disconnection_alerts' then array['id','identity_id','driver_id','source','vehicle_key','contract_id','duty_key','observed_online_at','disconnected_at','opened_at','last_seen_at','status','resolved_at','evidence']::text[]
 when 'fleet_disconnection_checkpoints' then array['identity_id','state','updated_at']::text[]
 when 'fleet_driver_performance_sync' then array['source','organization_id','driver_id','covered_from','covered_to','last_attempt_at','last_success_at','status','row_count','last_error']::text[]
 when 'fleet_driver_report_summaries' then array['source','organization_id','driver_id','report_type','period_from','period_to','reported_at','trips_completed','online_seconds','trip_seconds','acceptance_rate','cancellation_rate','completion_rate','accepted_count','rejected_count','cancelled_count']::text[]
 when 'fleet_drivers' then array['id','name','ludy_driver_code','vehicle_key','agency_id','created_at','link_method','link_evidence','vehicle_link_method','vehicle_link_evidence','auto_link_disabled']::text[]
 when 'fleet_identities' then array['id','driver_id','source','source_key','external_id','organization_id','provisional']::text[]
 when 'fleet_inventory_sync' then array['id','status','last_attempt_at','last_success_at','last_error','counts']::text[]
 when 'fleet_latest' then array['identity_id','driver_id','source','status','observed_at','received_at','source_at','event_at','vehicle_label','evidence','offline_since','offline_samples','recovery_samples']::text[]
 when 'fleet_motion_alerts' then array['id','driver_id','identity_id','vehicle_key','source','kind','severity','status','observed_since','opened_at','last_seen_at','resolved_at','distance_m','threshold_m','evidence']::text[]
 when 'fleet_motion_checkpoints' then array['identity_id','vehicle_key','source','state','updated_at']::text[]
 when 'fleet_myclicar_contracts' then array['external_id','num','client_code','name','plate','temporary_plate','model','status','start_at','effective_start_at','end_at','provider_updated_at','deleted','vehicle_key','vehicle_candidates','current','eligible','reason','observed_at','agency_id','vehicle_external_id','departure_agency_external_id','return_agency_external_id','details_verified']::text[]
 when 'fleet_myclicar_vehicles' then array['external_id','reference','plate','temporary_plate','brand','model','vin','fuel','status','is_blocked','archived','deleted_at','provider_updated_at','current','vehicle_key','agency_id','reason','observed_at']::text[]
 when 'fleet_observations' then array['id','driver_id','identity_id','source','status','observed_at','received_at','source_at','event_at','vehicle_label','evidence']::text[]
 when 'fleet_parking_events' then array['event_key','vehicle_key','zone_id','kind','observed_at','first_observed_at']::text[]
 when 'fleet_parking_state' then array['vehicle_key','zone_id','state','updated_at']::text[]
 when 'fleet_parking_zones' then array['id','name','kind','agency_id','shape','enabled','fingerprint','source','source_id','updated_at','revision','indicative','archived_at','archived_by']::text[]
 when 'fleet_provider_vehicles' then array['source','organization_id','external_id','plate','make','model','status','received_at']::text[]
 when 'fleet_rides' then array['source','organization_id','external_id','driver_id','status','started_at','finished_at','distance_km','duration_s','amount','currency','received_at','requested_at','accepted_at','pickup_duration_s','passenger_distance_km','tip_amount','booking_fee','toll_fee','cancellation_fee','stops','provider_driver_id','detail_origin','is_optional','provider_vehicle_id','vehicle_label']::text[]
 when 'fleet_rotation_contracts' then array['external_id','num','client_code','plate','temporary_plate','model','status','effective_start_at','end_at','provider_updated_at','deleted','vehicle_key','agency_id','observed_at','name','vehicle_external_id','departure_agency_external_id','details_verified']::text[]
 when 'fleet_rotation_sync' then array['id','status','last_attempt_at','last_success_at','last_error','from_at','to_at']::text[]
 when 'fleet_settings' then array['id','offline_threshold_s','schedule','enabled','disconnection_enabled','disconnection_policy','duty_mode']::text[]
 when 'fleet_source_events' then array['id','source','status','at','detail']::text[]
 when 'fleet_sources' then array['id','name','status','last_success_at','last_attempt_at','last_error','stale_after_s','coverage','metadata']::text[]
 when 'live_status' then array['vehicle_key','plate','model','state','speed','since_min','last_pos_at','lat','lon','ign_on','driver_name','contract_num','km_today','drive_min_today','idle_min_today','fuel_l_today','alerts_today','updated_at']::text[]
 when 'ops_demand_imports' then array['id','agency_id','city','file_name','fingerprint','counts','created_at']::text[]
 when 'ops_demand_rides' then array['agency_id','ride_key','import_id','city','external_id','started_at','pickup_zone','status']::text[]
 when 'ops_events' then array['id','source_id','external_key','source_url','city','title','place','starts_at','ends_at','source_date_text','time_precision','fingerprint','status','observed_at','reviewed_at','reviewed_by']::text[]
 when 'ops_fuel_checkpoints' then array['vehicle_key','state','updated_at']::text[]
 when 'ops_fuel_reference_runs' then array['id','status','last_attempt_at','last_success_at','next_attempt_at','last_error','candidates','applied','insufficient']::text[]
 when 'ops_fuel_settings' then array['id','enabled','excess_pct','min_distance_km','cooldown_minutes']::text[]
 when 'ops_rush_rules' then array['id','agency_id','city','days','start','end','label','enabled','created_at']::text[]
 when 'params' then array['key','value']::text[]
 when 'telemetry_observations' then array['id','source','source_event_id','device_id','vehicle_key','observed_at','collected_at','received_at','version','fingerprint','observation','origin','agency_id_at_receipt','mapping_basis']::text[]
 when 'uber_driver_report_imports' then array['organization_id','config_revision','report_type','file_sha256','period_from','period_to','counts','created_at','last_received_at']::text[]
 when 'uber_report_settings' then array['id','enabled','organization_id','city_agencies','date_format','revision','updated_at','last_attempt_at','last_success_at','last_status','last_error','last_counts','collector_seen_at','collector_state','organization_label','csv_timezone']::text[]
 when 'vehicles' then array['key','plate','brand','model','fuel','vin','geotab_id','geotab_name','tank_l','ref_l100','revenue','active','last_sync','other_plates','agency_id','myclicar_external_id','geotab_auto_link_disabled','fuel_reference_evidence']::text[]
 else null end $$;
create function desktop_worker_private.write_columns(p_resource text,p_method text) returns text[]
language sql immutable set search_path='' as $$ select case p_resource||':'||p_method
 when 'desktop_vehicle_live:POST' then array['vehicle_key','data','observed_at']::text[]
 when 'driver_notifications:POST' then array['account_id','event_key','kind','title','message','observed_at','evidence']::text[]
 when 'fleet_sources:PATCH' then array['status','last_success_at','last_attempt_at','last_error','stale_after_s','coverage','metadata']::text[]
 when 'fleet_source_events:POST' then array['source','status','at','detail']::text[]
 when 'fleet_drivers:POST' then array['name']::text[]
 when 'fleet_drivers:PATCH' then array['vehicle_key','vehicle_link_evidence']::text[]
 when 'fleet_identities:POST' then array['driver_id','source','source_key','external_id','organization_id','provisional']::text[]
 when 'fleet_observations:POST' then array['driver_id','identity_id','source','status','observed_at','received_at','source_at','event_at','vehicle_label','evidence']::text[]
 when 'fleet_latest:POST' then array['identity_id','driver_id','source','status','observed_at','received_at','source_at','event_at','vehicle_label','evidence','offline_since','offline_samples','recovery_samples']::text[]
 when 'fleet_latest:PATCH' then array['offline_since','offline_samples','recovery_samples']::text[]
 when 'fleet_provider_vehicles:POST' then array['source','organization_id','external_id','plate','make','model','status','received_at']::text[]
 when 'fleet_rides:POST' then array['source','organization_id','external_id','driver_id','status','started_at','finished_at','distance_km','duration_s','amount','currency','received_at','requested_at','accepted_at','pickup_duration_s','passenger_distance_km','tip_amount','booking_fee','toll_fee','cancellation_fee','stops','provider_driver_id','detail_origin','is_optional','provider_vehicle_id','vehicle_label']::text[]
 when 'fleet_alerts:POST' then array['driver_id','identity_id','source','observed_since','last_seen_at','threshold_s','rule']::text[]
 when 'fleet_alerts:PATCH' then array['status','last_seen_at','resolved_at']::text[]
 when 'fleet_motion_alerts:POST' then array['driver_id','identity_id','vehicle_key','source','kind','severity','status','observed_since','opened_at','last_seen_at','resolved_at','distance_m','threshold_m','evidence']::text[]
 when 'fleet_motion_alerts:PATCH' then array['status','last_seen_at','resolved_at','distance_m','evidence']::text[]
 when 'vehicles:PATCH' then array['geotab_id','geotab_name']::text[]
 when 'live_status:POST' then array['vehicle_key','plate','model','state','speed','since_min','last_pos_at','lat','lon','ign_on','driver_name','contract_num','km_today','drive_min_today','idle_min_today','fuel_l_today','alerts_today','updated_at']::text[]
 when 'live_status:DELETE' then array[]::text[]
 when 'fleet_rotation_sync:PATCH' then array['status','last_attempt_at','last_error']::text[]
 when 'fleet_inventory_sync:PATCH' then array['status','last_attempt_at','last_error']::text[]
 when 'fleet_driver_performance_sync:POST' then array['source','organization_id','driver_id','status','last_attempt_at','last_error']::text[]
 when 'uber_report_settings:PATCH' then array['last_attempt_at','last_status','last_error','collector_seen_at','collector_state']::text[]
 when 'ops_fuel_checkpoints:POST' then array['vehicle_key','state','updated_at']::text[]
 when 'ops_fuel_checkpoints:DELETE' then array[]::text[]
 when 'ops_fuel_reference_runs:PATCH' then array['status','last_attempt_at','last_success_at','next_attempt_at','last_error','candidates','applied','insufficient']::text[]
 else null end $$;
create function desktop_worker_private.conflict_columns(p_resource text) returns text
language sql immutable set search_path='' as $$ select case p_resource
 when 'desktop_vehicle_live' then 'vehicle_key'
 when 'driver_notifications' then 'account_id,event_key'
 when 'fleet_observations' then 'identity_id,observed_at'
 when 'fleet_latest' then 'identity_id'
 when 'fleet_provider_vehicles' then 'source,organization_id,external_id'
 when 'fleet_rides' then 'source,organization_id,external_id'
 when 'fleet_alerts' then 'identity_id,observed_since'
 when 'fleet_motion_alerts' then 'identity_id,vehicle_key,observed_since'
 when 'live_status' then 'vehicle_key'
 when 'fleet_driver_performance_sync' then 'source,organization_id,driver_id'
 when 'ops_fuel_checkpoints' then 'vehicle_key'
 else null end $$;

-- A deliberately small PostgREST subset, not SQL or an arbitrary REST proxy.
-- Identifiers must come from the frozen column list; all values are SQL literals
-- escaped by format(%L), including JSON equality evidence. JSON paths are fixed.
create function desktop_worker_private.predicate(p_column text,p_value text,p_columns text[]) returns text
language plpgsql immutable set search_path='' as $$
declare col text;op text;val text;parts text[];item text;quoted text[]:='{}';json_list jsonb;
begin
 if p_column='observation->>metric' and 'observation'=any(p_columns) then col:='(t.observation->>''metric'')';
 elsif p_column=any(p_columns) then col:=format('t.%I',p_column);
 else raise exception using errcode='22023',message='Unsupported desktop filter column';end if;
 if p_value is null or length(p_value)>65536 then raise exception using errcode='22023',message='Invalid desktop filter';end if;
 if p_value in ('is.null','not.is.null','is.true','is.false') then
  return col||case p_value when 'is.null' then ' is null' when 'not.is.null' then ' is not null' when 'is.true' then ' is true' else ' is false' end;
 end if;
 op:=split_part(p_value,'.',1);val:=substring(p_value from length(op)+2);
 if op in ('eq','neq','gt','gte','lt','lte') then
  return col||case op when 'eq' then '=' when 'neq' then '<>' when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end||format('%L',val);
 elsif op='in' and left(val,1)='(' and right(val,1)=')' then
  if val ~ '["\\]' then
   begin json_list:=('['||substring(val from 2 for length(val)-2)||']')::jsonb;
   exception when invalid_text_representation then raise exception using errcode='22023',message='Invalid desktop quoted list';end;
   if jsonb_array_length(json_list) not between 1 and 1000 or exists(select 1 from jsonb_array_elements(json_list) x where jsonb_typeof(x)<>'string') then
    raise exception using errcode='22023',message='Desktop quoted lists require strings';end if;
   select array_agg(x) into parts from jsonb_array_elements_text(json_list) x;
  else parts:=string_to_array(substring(val from 2 for length(val)-2),',');end if;
  if cardinality(parts) not between 1 and 1000 then raise exception using errcode='22023',message='Unsupported desktop list filter';end if;
  foreach item in array parts loop quoted:=array_append(quoted,format('%L',item));end loop;
  return col||' in ('||array_to_string(quoted,',')||')';
 end if;
 raise exception using errcode='22023',message='Unsupported desktop filter';
end $$;

create function desktop_worker_private.rpc(p_resource text,p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare expected text[];result jsonb;
begin
 expected:=case p_resource
 when 'rpc/fleet_save_motion_checkpoints' then array['p_states']::text[]
 when 'rpc/fleet_commit_parking' then array['p_states','p_events']::text[]
 when 'rpc/ops_set_measured_fuel_reference' then array['p_vehicle','p_device','p_reference']::text[]
 when 'rpc/fleet_sync_rotation_contracts' then array['p_contracts','p_observed_at','p_from','p_to']::text[]
 when 'rpc/fleet_import_bolt_performance' then array['p_org','p_rows','p_coverage','p_at']::text[]
 when 'rpc/fleet_commit_disconnections' then array['p_states','p_alerts','p_changes']::text[]
 when 'rpc/provider_earnings_commit' then array['p_snapshot']::text[]
 when 'rpc/fleet_auto_link_driver' then array['p_driver','p_ludy_code','p_platform_name','p_ludy_name']::text[]
 when 'rpc/fleet_auto_link_driver_spacing' then array['p_driver','p_ludy_code','p_platform_name','p_ludy_name']::text[]
 when 'rpc/fleet_auto_link_vehicle' then array['p_driver','p_vehicle_key','p_evidence']::text[]
 when 'rpc/fleet_auto_link_myclicar_vehicle' then array['p_driver','p_contract_id']::text[]
 when 'rpc/fleet_sync_myclicar' then array['p_contracts','p_observed_at']::text[]
 when 'rpc/fleet_sync_inventory' then array['p_vehicles','p_agencies','p_observed_at']::text[]
 when 'rpc/fleet_reconcile_vehicle_contracts' then array[]::text[]
 when 'rpc/uber_driver_report_commit' then array['p_org','p_revision','p_hash','p_type','p_batches','p_rows','p_counts','p_from','p_to']::text[]
 when 'rpc/telemetry_archive_ingest' then array['p_events']::text[]
 when 'rpc/ops_ingest_events' then array['p_source','p_rows','p_at']::text[]
 else null end;
 if expected is null or jsonb_typeof(p_body) is distinct from 'object' or not(p_body ?& expected)
  or exists(select 1 from jsonb_object_keys(p_body) k where not(k=any(expected))) then
  raise exception using errcode='22023',message='Unsupported desktop RPC arguments';end if;
 -- Static calls, with exact argument casts: overload names and arbitrary SQL
 -- cannot be supplied by a client. Original auth.uid()/JWT claims are preserved.
 case p_resource
 when 'rpc/fleet_save_motion_checkpoints' then perform public.fleet_save_motion_checkpoints(p_body->'p_states');result:='null'::jsonb;
 when 'rpc/fleet_commit_parking' then perform public.fleet_commit_parking(p_body->'p_states',p_body->'p_events');result:='null'::jsonb;
 when 'rpc/ops_set_measured_fuel_reference' then select to_jsonb(public.ops_set_measured_fuel_reference((p_body->>'p_vehicle')::text,(p_body->>'p_device')::text,p_body->'p_reference')) into result;
 when 'rpc/fleet_sync_rotation_contracts' then select to_jsonb(public.fleet_sync_rotation_contracts(p_body->'p_contracts',(p_body->>'p_observed_at')::timestamptz,(p_body->>'p_from')::timestamptz,(p_body->>'p_to')::timestamptz)) into result;
 when 'rpc/fleet_import_bolt_performance' then select to_jsonb(public.fleet_import_bolt_performance((p_body->>'p_org')::text,p_body->'p_rows',p_body->'p_coverage',(p_body->>'p_at')::timestamptz)) into result;
 when 'rpc/fleet_commit_disconnections' then select to_jsonb(public.fleet_commit_disconnections(p_body->'p_states',p_body->'p_alerts',p_body->'p_changes')) into result;
 when 'rpc/provider_earnings_commit' then select to_jsonb(public.provider_earnings_commit(p_body->'p_snapshot')) into result;
 when 'rpc/fleet_auto_link_driver' then select to_jsonb(public.fleet_auto_link_driver((p_body->>'p_driver')::uuid,(p_body->>'p_ludy_code')::text,(p_body->>'p_platform_name')::text,(p_body->>'p_ludy_name')::text)) into result;
 when 'rpc/fleet_auto_link_driver_spacing' then select to_jsonb(public.fleet_auto_link_driver_spacing((p_body->>'p_driver')::uuid,(p_body->>'p_ludy_code')::text,(p_body->>'p_platform_name')::text,(p_body->>'p_ludy_name')::text)) into result;
 when 'rpc/fleet_auto_link_vehicle' then select to_jsonb(public.fleet_auto_link_vehicle((p_body->>'p_driver')::uuid,(p_body->>'p_vehicle_key')::text,p_body->'p_evidence')) into result;
 when 'rpc/fleet_auto_link_myclicar_vehicle' then select to_jsonb(public.fleet_auto_link_myclicar_vehicle((p_body->>'p_driver')::uuid,(p_body->>'p_contract_id')::text)) into result;
 when 'rpc/fleet_sync_myclicar' then select to_jsonb(public.fleet_sync_myclicar(p_body->'p_contracts',(p_body->>'p_observed_at')::timestamptz)) into result;
 when 'rpc/fleet_sync_inventory' then select to_jsonb(public.fleet_sync_inventory(p_body->'p_vehicles',p_body->'p_agencies',(p_body->>'p_observed_at')::timestamptz)) into result;
 when 'rpc/fleet_reconcile_vehicle_contracts' then select to_jsonb(public.fleet_reconcile_vehicle_contracts()) into result;
 when 'rpc/uber_driver_report_commit' then select to_jsonb(public.uber_driver_report_commit((p_body->>'p_org')::uuid,(p_body->>'p_revision')::bigint,(p_body->>'p_hash')::text,(p_body->>'p_type')::text,p_body->'p_batches',p_body->'p_rows',p_body->'p_counts',(p_body->>'p_from')::timestamptz,(p_body->>'p_to')::timestamptz)) into result;
 when 'rpc/telemetry_archive_ingest' then select to_jsonb(public.telemetry_archive_ingest(p_body->'p_events')) into result;
 when 'rpc/ops_ingest_events' then select to_jsonb(public.ops_ingest_events((p_body->>'p_source')::text,p_body->'p_rows',(p_body->>'p_at')::timestamptz)) into result;
 else raise exception using errcode='22023',message='Unsupported desktop RPC';
 end case;
 return coalesce(result,'null'::jsonb);
end $$;

create function public.desktop_worker_request(p_device_id uuid,p_fence bigint,p_resource text,p_method text,
 p_params jsonb default '{}'::jsonb,p_body jsonb default null,p_prefer text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
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
end $$;

-- Do not rely on the database's default EXECUTE grants.
revoke all on all functions in schema desktop_worker_private from public,anon,authenticated,service_role;
revoke all on function public.desktop_worker_register(uuid,text,boolean),public.desktop_worker_status(uuid),
 public.desktop_worker_claim(uuid),public.desktop_worker_renew(uuid,bigint),public.desktop_worker_release(uuid,bigint),
 public.desktop_worker_request(uuid,bigint,text,text,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.desktop_worker_register(uuid,text,boolean),public.desktop_worker_status(uuid),
 public.desktop_worker_claim(uuid),public.desktop_worker_renew(uuid,bigint),public.desktop_worker_release(uuid,bigint),
 public.desktop_worker_request(uuid,bigint,text,text,jsonb,jsonb,text) to authenticated;
