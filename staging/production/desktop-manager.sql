-- Two existing manager intents, scoped to confirmed agency memberships.
-- No device, collector lease, service-role JWT, or administrative delegation.
-- Install after reviewed business-schema variants; never rewrite environment.
create function public.desktop_manager_request(p_resource text,p_method text,
 p_params jsonb default '{}'::jsonb,p_body jsonb default null,p_prefer text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
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
end $$;
revoke all on function public.desktop_manager_request(text,text,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.desktop_manager_request(text,text,jsonb,jsonb,text) to authenticated;
