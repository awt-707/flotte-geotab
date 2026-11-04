-- Staging only. A report certifies a provider UUID; it never changes a person,
-- agency, current vehicle, source freshness or live/offline observation.
do $$ begin
 if (select value from public.params where key='environment') is distinct from 'staging'
 then raise exception 'Staging required';end if;
end $$;

create function public.uber_report_promote_identities(p_org uuid,p_rows jsonb,p_mapping jsonb,p_hash text,p_type text)
returns integer language plpgsql security definer set search_path=public as $$
declare pair record;ids uuid[];identity_row public.fleet_identities;driver_row public.fleet_drivers;
 reference_row public.drivers;promoted integer:=0;changed integer;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
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
end $$;
revoke all on function public.uber_report_promote_identities(uuid,jsonb,jsonb,text,text) from public,anon,authenticated,service_role;

alter function public.uber_driver_report_commit(uuid,bigint,text,text,jsonb,jsonb,jsonb,timestamptz,timestamptz)
 rename to uber_driver_report_commit_without_identity_promotion;
revoke all on function public.uber_driver_report_commit_without_identity_promotion(uuid,bigint,text,text,jsonb,jsonb,jsonb,timestamptz,timestamptz)
 from public,anon,authenticated,service_role;

create function public.uber_driver_report_commit(p_org uuid,p_revision bigint,p_hash text,p_type text,p_batches jsonb,p_rows jsonb,p_counts jsonb,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare config public.uber_report_settings;promoted integer;result jsonb;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Staging required';end if;
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
end $$;
revoke all on function public.uber_driver_report_commit(uuid,bigint,text,text,jsonb,jsonb,jsonb,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.uber_driver_report_commit(uuid,bigint,text,text,jsonb,jsonb,jsonb,timestamptz,timestamptz) to service_role;
