-- Local staging only. Read-only provider catalog, exact references and agency scope.
alter table public.vehicles add column myclicar_external_id text unique;
alter table public.vehicles add column geotab_auto_link_disabled boolean not null default false;
-- A previously unlinked local row may represent a manual dissociation.
update public.vehicles set geotab_auto_link_disabled=true where geotab_id is null;

create table public.fleet_myclicar_agencies (
 external_id text primary key check(length(external_id) between 1 and 120),
 code text not null,name text not null,agency_id bigint references public.agencies(id) on delete set null,
 provider_updated_at timestamptz,observed_at timestamptz not null,current boolean not null default true,
 check(length(code) between 1 and 120 and length(name) between 1 and 160)
);
create table public.fleet_myclicar_vehicles (
 external_id text primary key check(length(external_id) between 1 and 120),reference text not null,
 plate text not null default '',temporary_plate text not null default '',brand text not null default '',model text not null default '',
 vin text not null default '',fuel text not null default '',status text not null check(status in('AVAILABLE','RENTED','RESERVED')),
 is_blocked boolean not null default false,archived boolean not null default false,deleted_at timestamptz,provider_updated_at timestamptz,
 current boolean not null default true,vehicle_key text references public.vehicles(key) on delete set null,
 agency_id bigint references public.agencies(id) on delete set null,reason text not null default '',observed_at timestamptz not null,
 check(length(reference) between 1 and 120 and length(plate)<=120 and length(temporary_plate)<=120 and length(vin)<=120)
);
create index fleet_myclicar_inventory_vehicle on public.fleet_myclicar_vehicles(vehicle_key);
create table public.fleet_inventory_sync (
 id integer primary key default 1 check(id=1),status text not null default 'unconnected' check(status in('unconnected','healthy','error')),
 last_attempt_at timestamptz,last_success_at timestamptz,last_error text,counts jsonb not null default '{}'
);
insert into public.fleet_inventory_sync(id) values(1);
alter table public.fleet_myclicar_agencies enable row level security;
alter table public.fleet_myclicar_vehicles enable row level security;
alter table public.fleet_inventory_sync enable row level security;
revoke all on public.fleet_myclicar_agencies,public.fleet_myclicar_vehicles,public.fleet_inventory_sync from public,anon,authenticated;
grant select on public.fleet_myclicar_agencies,public.fleet_myclicar_vehicles,public.fleet_inventory_sync to authenticated;
grant all on public.fleet_myclicar_agencies,public.fleet_myclicar_vehicles,public.fleet_inventory_sync to service_role;
create policy read_scope on public.fleet_myclicar_agencies for select to authenticated using(public.my_role() in('admin','manager','viewer') and (public.is_admin() or agency_id=any(public.my_agency_ids())));
create policy read_scope on public.fleet_myclicar_vehicles for select to authenticated using(public.my_role() in('admin','manager','viewer') and (public.is_admin() or agency_id=any(public.my_agency_ids())));
-- Global counts remain administrative; scoped pages count their own rows.
create policy read_admin on public.fleet_inventory_sync for select to authenticated using(public.is_admin());

create function public.fleet_sync_inventory(p_vehicles jsonb,p_agencies jsonb,p_observed_at timestamptz)
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
   select array_agg(id order by id) into agency_ids from public.agencies where lower(regexp_replace(trim(name),'\s+',' ','g'))=lower(regexp_replace(trim(item.name),'\s+',' ','g'));
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
   if cardinality(matches)=1 and not exists(select 1 from public.vehicles where key=matches[1] and myclicar_external_id is not null and myclicar_external_id<>item.external_id) then target:=matches[1];
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
 from _inventory_vehicles i where v.key=i.vehicle_key and (v.myclicar_external_id is null or v.myclicar_external_id=i.external_id);
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

alter table public.fleet_myclicar_contracts add column agency_id bigint references public.agencies(id) on delete set null,
 add column vehicle_external_id text,add column departure_agency_external_id text,add column return_agency_external_id text,add column details_verified boolean not null default false;
update public.fleet_myclicar_contracts c set agency_id=v.agency_id from public.vehicles v where v.key=c.vehicle_key;
drop policy read_admin on public.fleet_myclicar_contracts;
create policy read_scope on public.fleet_myclicar_contracts for select to authenticated using(public.my_role() in('admin','manager','viewer') and (public.is_admin() or agency_id=any(public.my_agency_ids())));
alter function public.fleet_sync_myclicar(jsonb,timestamptz) rename to fleet_sync_myclicar_reference_base;
revoke all on function public.fleet_sync_myclicar_reference_base(jsonb,timestamptz) from public,anon,authenticated,service_role;
create function public.fleet_sync_myclicar(p_contracts jsonb,p_observed_at timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Base locale de staging obligatoire';end if;
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
end $$;
revoke all on function public.fleet_sync_myclicar(jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.fleet_sync_myclicar(jsonb,timestamptz) to service_role;
