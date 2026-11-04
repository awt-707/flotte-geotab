-- Staging only. A verified returned contract identifies a person, but does not
-- establish a current vehicle assignment or an active duty period.
alter table public.fleet_rotation_contracts
  add column name text not null default '',
  add column vehicle_external_id text,
  add column departure_agency_external_id text,
  add column details_verified boolean not null default false;

alter function public.fleet_sync_rotation_contracts(jsonb,timestamptz,timestamptz,timestamptz)
  rename to fleet_sync_rotation_contracts_history_base;
revoke all on function public.fleet_sync_rotation_contracts_history_base(jsonb,timestamptz,timestamptz,timestamptz)
  from public,anon,authenticated,service_role;

create function public.fleet_sync_rotation_contracts(p_contracts jsonb,p_observed_at timestamptz,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
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
end $$;
revoke all on function public.fleet_sync_rotation_contracts(jsonb,timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.fleet_sync_rotation_contracts(jsonb,timestamptz,timestamptz,timestamptz) to service_role;

-- Preserve the newer report tables when a platform profile is merged into its
-- canonical Ludy person. The original function transfers identities first and
-- its existing trigger preserves disconnection incidents/checkpoints.
alter function public.fleet_link_driver_base(uuid,text,text,bigint) rename to fleet_link_driver_reference_base;
revoke all on function public.fleet_link_driver_reference_base(uuid,text,text,bigint) from public,anon,authenticated,service_role;
create function public.fleet_link_driver_base(p_driver uuid,p_ludy_code text,p_vehicle_key text default null,p_agency_id bigint default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare target uuid;
begin
  if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Base locale de staging obligatoire';end if;
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
end $$;
revoke all on function public.fleet_link_driver_base(uuid,text,text,bigint) from public,anon,authenticated,service_role;

-- Same exact token rule as the server: compatibility decomposition, removal of
-- combining accents, punctuation separators and sorted complete name tokens.
create function public.fleet_normalized_name(p_name text) returns text
language sql immutable set search_path=public as $$
  select coalesce(string_agg(token,' ' order by token collate "C"),'')
  from regexp_split_to_table(lower(regexp_replace(normalize(coalesce(p_name,''),NFKD),U&'[\0300-\036f]','','g')),'[^[:alnum:]]+') token
  where token<>''
$$;
revoke all on function public.fleet_normalized_name(text) from public,anon,authenticated;
grant execute on function public.fleet_normalized_name(text) to service_role;

create or replace function public.fleet_auto_link_driver(p_driver uuid,p_ludy_code text,p_platform_name text,p_ludy_name text)
returns uuid language plpgsql security definer set search_path=public as $$
declare old_row public.fleet_drivers%rowtype;ref_row public.drivers%rowtype;existing public.fleet_drivers%rowtype;target uuid;k text;proof jsonb;
begin
  if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Base locale de staging obligatoire';end if;
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
end $$;

alter function public.fleet_auto_link_driver_spacing(uuid,text,text,text) rename to fleet_auto_link_driver_spacing_base;
revoke all on function public.fleet_auto_link_driver_spacing_base(uuid,text,text,text) from public,anon,authenticated,service_role;
create function public.fleet_auto_link_driver_spacing(p_driver uuid,p_ludy_code text,p_platform_name text,p_ludy_name text)
returns uuid language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('fleet-link-assignments',0));
  if exists(select 1 from public.fleet_drivers where ludy_driver_code=p_ludy_code and auto_link_disabled) then return null;end if;
  return public.fleet_auto_link_driver_spacing_base(p_driver,p_ludy_code,p_platform_name,p_ludy_name);
end $$;
revoke all on function public.fleet_auto_link_driver(uuid,text,text,text),public.fleet_auto_link_driver_spacing(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.fleet_auto_link_driver(uuid,text,text,text),public.fleet_auto_link_driver_spacing(uuid,text,text,text) to service_role;


-- The legacy contract importer must not delete current MyClicar people, detach
-- platform identities, or fail on a driver's portal foreign key. It only owns
-- references derived from its own contracts table.
create or replace function public.refresh_drivers()
returns jsonb language plpgsql set search_path = public as $$
declare news jsonb; dupes jsonb;
begin
  if (select value from public.params where key='environment') is distinct from 'staging' then raise exception 'Base locale de staging obligatoire';end if;
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
end $$;
revoke execute on function public.refresh_drivers() from public, anon, authenticated;
grant execute on function public.refresh_drivers() to service_role;
