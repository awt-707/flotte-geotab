-- Explicit administrator actions from an authenticated HTTP request context.
-- Install after desktop-workers.sql and the reviewed business schema variants.
-- No collector lease is borrowed or manufactured. This gateway does not accept
-- public driver dps_* sessions, provider ingestion, or free table/RPC access.
create function desktop_worker_private.admin_columns(p_resource text) returns text[]
language sql immutable set search_path='' as $$ select case p_resource
 when 'driver_portal_accounts' then array['id','ludy_driver_code','agency_id','display_name','active','created_at','rotated_at']
 when 'driver_reports' then array['id','account_id','category','city','place','description','status','admin_note','reported_at','reviewed_at','reviewed_by']
 else desktop_worker_private.read_columns(p_resource) end $$;

create function public.desktop_admin_request(p_device_id uuid,p_resource text,p_method text,
 p_params jsonb default '{}'::jsonb,p_body jsonb default null,p_prefer text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
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
end $$;
revoke all on function desktop_worker_private.admin_columns(text) from public,anon,authenticated,service_role;
revoke all on function public.desktop_admin_request(uuid,text,text,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.desktop_admin_request(uuid,text,text,jsonb,jsonb,text) to authenticated;
