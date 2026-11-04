-- Local staging only. Canonical agencies and archived vehicle references.
-- Keep every manual choice and every provider observation timestamp intact.
create function public.fleet_myclicar_agency_label(p_value text) returns text
language sql immutable set search_path=public as $$
 select lower(regexp_replace(regexp_replace(trim(coalesce(p_value,'')),'^(agence|agency)\s+','','i'),'\s+',' ','g'))
$$;
revoke all on function public.fleet_myclicar_agency_label(text) from public,anon,authenticated;
grant execute on function public.fleet_myclicar_agency_label(text) to service_role;

create or replace function public.fleet_sync_inventory(p_vehicles jsonb,p_agencies jsonb,p_observed_at timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare item record; matches text[]; target text; agency_ids bigint[]; local_agency bigint; result jsonb;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Base locale de staging obligatoire';end if;
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
end $$;
revoke all on function public.fleet_sync_inventory(jsonb,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.fleet_sync_inventory(jsonb,jsonb,timestamptz) to service_role;

-- Repair only the importer-created alias situation: the bound agency has no
-- city, its name exactly matches the provider label, and one existing agency
-- has that exact city. Genuine inter-agency changes remain unresolved.
do $repair$
declare inventory_at timestamptz;contracts_at timestamptz;payload jsonb;agencies_payload jsonb;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Base locale de staging obligatoire';end if;
 perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
 create temporary table _inventory_agency_repairs on commit drop as
 select m.external_id,m.agency_id old_id,min(a.id) new_id
 from public.fleet_myclicar_agencies m join public.agencies old on old.id=m.agency_id
 join public.agencies a on a.id<>m.agency_id and nullif(trim(a.city),'') is not null
  and public.fleet_myclicar_agency_label(a.city)=public.fleet_myclicar_agency_label(m.name)
 where m.current and nullif(trim(old.city),'') is null
  and public.fleet_myclicar_agency_label(old.name)=public.fleet_myclicar_agency_label(m.name)
 group by m.external_id,m.agency_id having count(*)=1;
 insert into public.params(key,value)
 select 'myclicar_agency_aliases',jsonb_object_agg(old_id::text,new_id::text)::text from _inventory_agency_repairs having count(*)>0
 on conflict(key) do update set value=(coalesce(public.params.value::jsonb,'{}'::jsonb)||excluded.value::jsonb)::text;
 update public.fleet_myclicar_agencies m set agency_id=r.new_id from _inventory_agency_repairs r where m.external_id=r.external_id;
 -- Only new provider-owned rows under the duplicate agency may move. An
 -- established/manual vehicle or driver keeps its agency unchanged.
 update public.vehicles v set agency_id=r.new_id
 from _inventory_agency_repairs r where v.agency_id=r.old_id and v.key='myclicar:'||v.myclicar_external_id
  and exists(select 1 from public.fleet_myclicar_contracts c where c.current and c.details_verified
   and c.status='IN_PROGRESS' and not c.deleted and c.end_at is null and c.effective_start_at<=c.observed_at
   and c.vehicle_external_id=v.myclicar_external_id and c.departure_agency_external_id=r.external_id);
 create temporary table _inventory_driver_repairs on commit drop as
 select d.code,d.agency_id old_id,r.new_id from public.drivers d join _inventory_agency_repairs r on d.agency_id=r.old_id
 where d.source='myclicar' and exists(select 1 from public.fleet_myclicar_contracts c where c.current and c.details_verified
  and c.status='IN_PROGRESS' and not c.deleted and c.end_at is null and c.effective_start_at<=c.observed_at
  and c.client_code=d.code and c.departure_agency_external_id=r.external_id)
 and not exists(select 1 from public.fleet_drivers f where f.ludy_driver_code=d.code and (f.auto_link_disabled or f.link_method='manual'));
 update public.drivers d set agency_id=r.new_id from _inventory_driver_repairs r where d.code=r.code and d.agency_id=r.old_id;
 update public.fleet_drivers f set agency_id=r.new_id from _inventory_driver_repairs r
 where f.ludy_driver_code=r.code and f.agency_id=r.old_id and not f.auto_link_disabled and f.link_method in('exact_name','name_spacing');
 -- Reconcile a still-fresh complete local snapshot without requesting the
 -- provider and without presenting the replay as a new observation.
 select last_success_at into inventory_at from public.fleet_inventory_sync where id=1 and status='healthy';
 if inventory_at between now()-interval '300 seconds' and now()+interval '5 seconds'
  and not exists(select 1 from public.fleet_myclicar_vehicles where current and observed_at is distinct from inventory_at)
  and not exists(select 1 from public.fleet_myclicar_agencies where current and observed_at is distinct from inventory_at) then
  select coalesce(jsonb_agg(to_jsonb(v)),'[]') into payload from public.fleet_myclicar_vehicles v where current;
  select coalesce(jsonb_agg(to_jsonb(a)),'[]') into agencies_payload from public.fleet_myclicar_agencies a where current;
  perform public.fleet_sync_inventory(payload,agencies_payload,inventory_at);
 end if;
 select max(observed_at) into contracts_at from public.fleet_myclicar_contracts where current;
 if contracts_at between now()-interval '300 seconds' and now()+interval '5 seconds'
  and not exists(select 1 from public.fleet_myclicar_contracts where current and observed_at is distinct from contracts_at) then
  select coalesce(jsonb_agg(to_jsonb(c)),'[]') into payload from public.fleet_myclicar_contracts c where current;
  perform public.fleet_sync_myclicar(payload,contracts_at);
 end if;
 -- No agency is deleted and no manager, viewer or portal access is reassigned.
 drop table _inventory_driver_repairs;drop table _inventory_agency_repairs;
end $repair$;
