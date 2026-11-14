-- =============================================================================
-- Chauffeurs et contrats de location (structure)
-- Contrats injectés depuis l'extract (import_contracts) et chauffeurs qui en sont déduits (refresh_drivers).
-- Tables : contracts, drivers
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.contract_first() RETURNS TABLE(vehicle_key text, first_start timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select vehicle_key, min(start_at) from contracts where vehicle_key is not null and start_at is not null group by 1
$$;

CREATE FUNCTION public.drivers_guard_trg() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is not null and not is_admin() and old.agency_id is not null and new.agency_id is distinct from old.agency_id
     and not (coalesce(new.agency_id, -1) = any(my_agency_ids())) then
    raise exception 'chauffeur rattaché à une agence : seul l''administrateur peut le retirer';
  end if;
  if auth.uid() is not null and not is_admin() and old.agency_id is not null and new.agency_id is null then
    raise exception 'chauffeur rattaché à une agence : seul l''administrateur peut le retirer';
  end if;
  return new;
end $$;

CREATE FUNCTION public.import_contracts(p_rows jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare rd jsonb := '{}'; n_add integer; n_upd integer; n_same integer; n_skip integer := 0; m timestamptz; adm boolean := is_admin(); keys text[] := my_vehicle_keys();
begin
  if coalesce(my_role(), '') not in ('admin', 'manager') then raise exception 'droits insuffisants'; end if;
  create temp table _c on commit drop as
    select distinct on (r.num) r.* from jsonb_populate_recordset(null::contracts, coalesce(p_rows, '[]')) r where coalesce(r.num, '') <> '' order by r.num;
  if not adm then
    select count(*) into n_skip from _c c left join contracts o on o.num = c.num
     where not (coalesce(c.vehicle_key, '') = any(keys)) or (o.num is not null and not (coalesce(o.vehicle_key, '') = any(keys)));
    delete from _c c using (select c2.num from _c c2 left join contracts o on o.num = c2.num
      where not (coalesce(c2.vehicle_key, '') = any(keys)) or (o.num is not null and not (coalesce(o.vehicle_key, '') = any(keys)))) x where c.num = x.num;
  end if;
  create temp table _s on commit drop as
    select c.*, o.num is not null as known, o.start_at as old_start, o.imported_at as old_imported,
      (o.num is not null and o.client_code is not distinct from c.client_code and o.name is not distinct from c.name and o.vehicle_key is not distinct from c.vehicle_key
        and o.start_at is not distinct from c.start_at and o.end_at is not distinct from c.end_at and coalesce(o.status, '') = coalesce(c.status, '')
        and o.plate is not distinct from c.plate and o.model is not distinct from c.model and o.origin is not distinct from c.origin
        and o.phone is not distinct from c.phone and o.email is not distinct from c.email and o.comment is not distinct from c.comment) as same
      from _c c left join contracts o on o.num = c.num;
  select count(*) filter (where not known), count(*) filter (where known and not same), count(*) filter (where same),
         least(min(start_at) filter (where not same), min(old_start) filter (where known and not same))
    into n_add, n_upd, n_same, m from _s;
  insert into contracts (num, client_code, name, plate, vehicle_key, model, start_at, end_at, status, origin, phone, email, comment, imported_at, updated_at)
  select num, client_code, name, plate, vehicle_key, model, start_at, end_at, status, origin, phone, email, comment, coalesce(old_imported, now()), now() from _s where not same
  on conflict (num) do update set client_code = excluded.client_code, name = excluded.name, plate = excluded.plate, vehicle_key = excluded.vehicle_key,
    model = excluded.model, start_at = excluded.start_at, end_at = excluded.end_at, status = excluded.status, origin = excluded.origin, phone = excluded.phone,
    email = excluded.email, comment = excluded.comment, imported_at = excluded.imported_at, updated_at = excluded.updated_at;
  -- nouveaux chauffeurs enregistrés tout de suite (fiche, agence, compte Uber), sans attendre le passage du collecteur
  if n_add + n_upd > 0 then rd := refresh_drivers(); end if;
  return jsonb_build_object('added', n_add, 'updated', n_upd, 'same', n_same, 'min_start', m, 'skipped', n_skip, 'new_drivers', coalesce(rd->'new', '[]'));
end $$;

CREATE FUNCTION public.refresh_drivers() RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare news jsonb; dupes jsonb;
begin
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
  delete from drivers where code not in (select code from _d) and source <> 'manuel';
  insert into drivers (code, name, other_names, phone, email, first_contract, last_contract, n_contracts, status, detected_at, note)
  select code, name, other_names, phone, email, first_c, last_c, n, status, detected_at, note from _d
  on conflict (code) do update set
    name = case when drivers.source = 'manuel' and coalesce(drivers.name, '') <> '' then drivers.name else excluded.name end,
    other_names = excluded.other_names,
    phone = case when drivers.source = 'manuel' and coalesce(drivers.phone, '') <> '' then drivers.phone else excluded.phone end,
    email = case when drivers.source = 'manuel' and coalesce(drivers.email, '') <> '' then drivers.email else excluded.email end,
    first_contract = excluded.first_contract, last_contract = excluded.last_contract, n_contracts = excluded.n_contracts,
    status = excluded.status, note = excluded.note;
  -- agence d'un chauffeur qui n'en a pas : celle du véhicule de son dernier contrat (un chauffeur rattaché n'est jamais déplacé)
  update drivers d set agency_id = v.agency_id
    from (select distinct on (c.client_code) c.client_code, ve.agency_id from contracts c join vehicles ve on ve.key = c.vehicle_key
           where coalesce(c.client_code, '') <> '' and ve.agency_id is not null order by c.client_code, c.start_at desc nulls last, c.num desc) v
   where d.code = v.client_code and d.agency_id is null;
  -- compte Uber : même téléphone (9 derniers chiffres), sinon même nom (mots dans n'importe quel ordre) ; seulement un candidat unique,
  -- jamais un compte déjà relié à un autre chauffeur, jamais un chauffeur déjà relié
  if to_regclass('public.uber_drivers') is not null then
    with dp as (select code, right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9) p, name_key(name) k from drivers where uber_uuid is null),
    up as (select uuid, right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9) p, name_key(name) k from uber_drivers u
            where not exists (select 1 from drivers x where x.uber_uuid = u.uuid)),
    byp as (select dp.code, min(up.uuid) uuid, count(*) n from dp join up on length(dp.p) = 9 and dp.p = up.p group by dp.code),
    byn as (select dp.code, min(up.uuid) uuid, count(*) n from dp join up on dp.k <> '' and dp.k = up.k group by dp.code),
    cand as (select dp.code, coalesce((select b.uuid from byp b where b.code = dp.code and b.n = 1), (select b.uuid from byn b where b.code = dp.code and b.n = 1)) uuid from dp),
    uniq as (select code, uuid from cand where uuid is not null and uuid in (select uuid from cand where uuid is not null group by uuid having count(*) = 1))
    update drivers d set uber_uuid = uniq.uuid from uniq where d.code = uniq.code and d.uber_uuid is null;
  end if;
  return jsonb_build_object('new', news, 'dupes', dupes);
end $$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.contracts (
    num text NOT NULL,
    client_code text,
    name text,
    plate text,
    vehicle_key text,
    model text,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    status text,
    origin text,
    phone text,
    email text,
    comment text,
    imported_at timestamp with time zone,
    updated_at timestamp with time zone
);

CREATE TABLE public.drivers (
    code text NOT NULL,
    name text,
    other_names text,
    phone text,
    email text,
    first_contract timestamp with time zone,
    last_contract timestamp with time zone,
    n_contracts integer,
    status text,
    detected_at timestamp with time zone,
    note text,
    agency_id bigint,
    source text DEFAULT 'contrats'::text NOT NULL,
    uber_uuid text
);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_pkey PRIMARY KEY (num);

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_pkey PRIMARY KEY (code);

CREATE INDEX contracts_client ON public.contracts USING btree (client_code);

CREATE INDEX contracts_start ON public.contracts USING btree (start_at DESC);

CREATE INDEX contracts_vehicle_start ON public.contracts USING btree (vehicle_key, start_at);

CREATE UNIQUE INDEX drivers_uber_uuid ON public.drivers USING btree (uber_uuid) WHERE (uber_uuid IS NOT NULL);

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER drivers_guard BEFORE UPDATE ON public.drivers FOR EACH ROW EXECUTE FUNCTION public.drivers_guard_trg();
