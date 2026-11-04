-- Local staging only. Raw observations are immutable; a changed source event
-- creates a visible competing version, never an overwritten historical fact.
do $$ begin
 if (select value from public.params where key='environment') is distinct from 'staging'
 then raise exception 'Staging required';end if;
end $$;

create table public.telemetry_observations (
 id uuid primary key default gen_random_uuid(),
 source text not null check(source in ('geotab','texat')),
 source_event_id text not null check(source_event_id ~ '^[a-f0-9]{64}$'),
 device_id text not null check(length(device_id) between 1 and 200),
 vehicle_key text not null check(length(vehicle_key) between 1 and 200),
 observed_at timestamptz not null, collected_at timestamptz not null,
 received_at timestamptz not null default clock_timestamp(),
 version integer not null check(version>0), fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 observation jsonb not null, origin jsonb not null,
 -- We have a current binding, not a historical vehicle/agency binding ledger.
 -- Never label the agency at receipt as the agency at measurement time.
 agency_id_at_receipt bigint, mapping_basis text not null check(mapping_basis='current_at_receipt'),
 unique(source,device_id,source_event_id,version), unique(source,device_id,source_event_id,fingerprint),
 check(isfinite(observed_at) and isfinite(collected_at) and isfinite(received_at)),
 check(observed_at<=collected_at+interval '1 minute'),
 check(jsonb_typeof(observation)='object' and pg_column_size(observation)<=8192),
 check(jsonb_typeof(origin)='object' and pg_column_size(origin)<=1024)
);
create index telemetry_vehicle_observed on public.telemetry_observations(vehicle_key,observed_at,id);
create index telemetry_received on public.telemetry_observations(received_at,id);
alter table public.telemetry_observations enable row level security;
revoke all on public.telemetry_observations from public,anon,authenticated,service_role;
grant select on public.telemetry_observations to authenticated,service_role;
create policy telemetry_observations_read on public.telemetry_observations for select to authenticated
 using((select public.is_admin()) or (public.my_role()='manager' and exists(
  select 1 from public.vehicles v where v.key=vehicle_key
   and v.agency_id=any((select public.my_agency_ids())::bigint[]))));

create function public.telemetry_archive_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Telemetry archive is append-only';end $$;
revoke all on function public.telemetry_archive_immutable() from public,anon,authenticated,service_role;
create trigger telemetry_archive_immutable before update or delete on public.telemetry_observations
 for each statement execute function public.telemetry_archive_immutable();

create function public.telemetry_archive_ingest(p_events jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 e jsonb;o jsonb;provenance jsonb;event_source text;event_id text;device text;vehicle text;
 observed timestamptz;collected timestamptz;agency bigint;bound_device text;
 semantic_hash text;found_row public.telemetry_observations%rowtype;next_version integer;inserted_id uuid;
 inserted_count integer:=0;duplicate_count integer:=0;conflict_count integer:=0;receipts jsonb:='[]'::jsonb;
 allowed text[];number_value numeric;raw_value numeric;
begin
 if (select value from public.params where key='environment') is distinct from 'staging'
 then raise exception 'Staging required';end if;
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
end $$;
revoke all on function public.telemetry_archive_ingest(jsonb) from public,anon,authenticated;
grant execute on function public.telemetry_archive_ingest(jsonb) to service_role;

-- Position/counter payloads are never added to Realtime publications.
do $$ begin
 if exists(select 1 from pg_publication_tables where schemaname='public' and tablename='telemetry_observations')
 then raise exception 'Telemetry archive must not be published';end if;
end $$;
