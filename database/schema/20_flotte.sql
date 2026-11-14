-- =============================================================================
-- Flotte : véhicules, parc, données Geotab, alertes, journal (structure)
-- Véhicules et parc (plaques, agences, sociétés), changements de plaque, données Geotab finalisées ou en direct
-- (trajets, ralentis, arrêts moteur, événements, carburant, jauge), alertes, journal par contrat, tickets de carte carburant.
-- Tables : alerts, engine_stops, events, fuel, fuel_card_tx, idles, journal, levels, live_status, parc, plate_changes, trips, vehicle_days, vehicles
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.alert_counts(p_from date, p_to date) RETURNS TABLE(vehicle_key text, type text, severity text, status text, n integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select vehicle_key, type, severity, status, count(*)::int from alerts where day between p_from and p_to group by 1, 2, 3, 4
$$;

CREATE FUNCTION public.driver_rule_counts(p_from date, p_to date) RETURNS TABLE(driver_code text, rule_id text, vehicle_key text, contract_num text, n integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with cd as (select contract_num, min(day) d from journal where contract_num is not null and contract_num <> '' group by 1)
  select e.driver_code, e.rule_id, e.vehicle_key, e.contract_num, count(*)::int
    from events e join rules r on r.id = e.rule_id and r.weight > 0
    left join cd on cd.contract_num = e.contract_num
   where e.day between p_from - 2 and p_to + 1 and coalesce(e.driver_code, '') not in ('', 'HORS_CONTRAT')
     and coalesce(cd.d, e.day) between p_from and p_to
   group by 1, 2, 3, 4
$$;

CREATE FUNCTION public.finalize_vdays(p_keys text[], p_trips jsonb, p_idles jsonb, p_events jsonb, p_fuel jsonb, p_levels jsonb, p_sync jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare r jsonb := '{}';
begin
  r := r || jsonb_build_object('trips', put_rows('trips', p_keys, p_trips, true));
  r := r || jsonb_build_object('idles', put_rows('idles', p_keys, p_idles, true));
  r := r || jsonb_build_object('events', put_rows('events', p_keys, p_events, true));
  r := r || jsonb_build_object('fuel', put_rows('fuel', p_keys, p_fuel, true));
  r := r || jsonb_build_object('levels', put_rows('levels', p_keys, p_levels, true));
  insert into vehicle_days select distinct on (id) * from jsonb_populate_recordset(null::vehicle_days, coalesce(p_sync, '[]'))
    on conflict (id) do update set vehicle_key = excluded.vehicle_key, day = excluded.day, synced_at = excluded.synced_at, n_trips = excluded.n_trips,
      n_events = excluded.n_events, n_levels = excluded.n_levels, fuel_counter = excluded.fuel_counter, speed_limits = excluded.speed_limits;
  update vehicles set last_sync = now() where key in (select split_part(k, '|', 1) from unnest(p_keys) k);
  return r;
end $$;

CREATE FUNCTION public.finalize_vdays(p_keys text[], p_trips jsonb, p_idles jsonb, p_events jsonb, p_fuel jsonb, p_levels jsonb, p_sync jsonb, p_stops jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare r jsonb;
begin
  r := public.finalize_vdays(p_keys, p_trips, p_idles, p_events, p_fuel, p_levels, p_sync);
  return r || jsonb_build_object('engine_stops', put_rows('engine_stops', p_keys, p_stops, true));
end $$;

CREATE FUNCTION public.import_fuel_card(p_rows jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare n_add integer; n_upd integer; n_same integer; n_skip integer := 0; adm boolean := is_admin(); keys text[] := my_vehicle_keys();
begin
  if coalesce(my_role(), '') not in ('admin', 'manager') then raise exception 'droits insuffisants'; end if;
  create temp table _f on commit drop as
    select distinct on (r.id) r.* from jsonb_populate_recordset(null::fuel_card_tx, coalesce(p_rows, '[]')) r
     where coalesce(r.id, '') <> '' and r.at is not null order by r.id;
  if not adm then
    select count(*) into n_skip from _f f left join fuel_card_tx o on o.id = f.id
     where not (coalesce(f.vehicle_key, '') = any(keys)) or (o.id is not null and not (coalesce(o.vehicle_key, '') = any(keys)));
    delete from _f f using (select f2.id from _f f2 left join fuel_card_tx o on o.id = f2.id
      where not (coalesce(f2.vehicle_key, '') = any(keys)) or (o.id is not null and not (coalesce(o.vehicle_key, '') = any(keys)))) x where f.id = x.id;
  end if;
  create temp table _g on commit drop as
    select f.*, o.id is not null as known,
      (o.id is not null and o.vehicle_key is not distinct from f.vehicle_key and o.at = f.at and o.liters is not distinct from f.liters
        and o.product is not distinct from f.product and o.amount_ttc is not distinct from f.amount_ttc and o.station is not distinct from f.station
        and o.plate is not distinct from f.plate and o.unit_price is not distinct from f.unit_price and o.mode is not distinct from f.mode
        and o.invoice is not distinct from f.invoice) as same
      from _f f left join fuel_card_tx o on o.id = f.id;
  select count(*) filter (where not known), count(*) filter (where known and not same), count(*) filter (where same) into n_add, n_upd, n_same from _g;
  insert into fuel_card_tx (id, card, vehicle_key, plate, at, day, product, liters, unit_price, amount_ttc, station, ticket, mode, invoice, imported_at, imported_by)
  select id, card, vehicle_key, plate, at, day, product, liters, unit_price, amount_ttc, station, ticket, mode, invoice, now(), auth.uid() from _g where not same
  on conflict (id) do update set card = excluded.card, vehicle_key = excluded.vehicle_key, plate = excluded.plate, at = excluded.at, day = excluded.day,
    product = excluded.product, liters = excluded.liters, unit_price = excluded.unit_price, amount_ttc = excluded.amount_ttc, station = excluded.station,
    ticket = excluded.ticket, mode = excluded.mode, invoice = excluded.invoice, imported_at = excluded.imported_at, imported_by = excluded.imported_by;
  return jsonb_build_object('added', n_add, 'updated', n_upd, 'same', n_same, 'skipped', n_skip);
end $$;

CREATE FUNCTION public.key_stats() RETURNS TABLE(vehicle_key text, n_days integer, n_contracts integer, in_data boolean)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with k as (
    select vehicle_key, count(*)::int nd, 0 nc, true d from vehicle_days group by 1
    union all select vehicle_key, 0, count(*)::int, false from contracts where vehicle_key is not null group by 1
    union all select distinct vehicle_key, 0, 0, true from trips
    union all select distinct vehicle_key, 0, 0, true from events
    union all select distinct vehicle_key, 0, 0, true from fuel
    union all select distinct vehicle_key, 0, 0, true from levels
    union all select distinct vehicle_key, 0, 0, true from idles)
  select vehicle_key, sum(nd)::int, sum(nc)::int, bool_or(d) from k group by 1
$$;

CREATE FUNCTION public.mark_notified(p_ids text[]) RETURNS integer
    LANGUAGE sql
    SET search_path TO 'public'
    AS $$
  with u as (update alerts set notified_at = now() where id = any(p_ids) and notified_at is null returning 1) select count(*)::int from u
$$;

CREATE FUNCTION public.parc_agency_for(p_key text, p_plate text, p_others text) RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p.agency_id from parc p
   where p.agency_id is not null
     and norm_plate(p.plate) in (select p_key union select norm_plate(p_plate) union select norm_plate(trim(x)) from unnest(regexp_split_to_array(coalesce(p_others, ''), '[,;]')) x)
   order by p.updated_at desc limit 1
$$;

CREATE FUNCTION public.parc_agency_trg() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare pl text; ag bigint;
begin
  if tg_op = 'DELETE' then pl := old.plate; ag := null; else pl := new.plate; ag := new.agency_id; end if;
  update vehicles v set agency_id = ag
   where v.agency_id is distinct from ag
     and norm_plate(pl) in (select v.key union select norm_plate(v.plate) union select norm_plate(trim(x)) from unnest(regexp_split_to_array(coalesce(v.other_plates, ''), '[,;]')) x);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

CREATE FUNCTION public.purge_before(p_table text, p_before date) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
declare n integer;
begin
  if p_table in ('trips', 'idles', 'events', 'fuel', 'levels', 'engine_stops') then execute format('delete from %I where vday < $1', p_table) using p_before;
  elsif p_table in ('vehicle_days', 'journal', 'alerts') then execute format('delete from %I where day < $1', p_table) using p_before;
  elsif p_table = 'logs' then delete from logs where at < p_before;
  elsif p_table = 'jobs' then delete from jobs where done_at is not null and created_at < p_before;
  else raise exception 'table %', p_table; end if;
  get diagnostics n = row_count; return n;
end $_$;

CREATE FUNCTION public.put_rows(p_table text, p_keys text[], p_rows jsonb, p_final boolean) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
declare n integer := 0; st jsonb := '{}';
begin
  if p_table not in ('trips', 'idles', 'events', 'fuel', 'levels', 'engine_stops') then raise exception 'table %', p_table; end if;
  p_rows := coalesce(p_rows, '[]'::jsonb); p_keys := coalesce(p_keys, '{}');
  if p_table = 'fuel' then
    select coalesce(jsonb_object_agg(id, status), '{}') into st from fuel
     where coalesce(status, '') <> '' and ((vehicle_key || '|' || vday::text) = any(p_keys)
       or id in (select x->>'id' from jsonb_array_elements(p_rows) x));
  end if;
  if p_final then
    execute format('delete from %I where (vehicle_key || ''|'' || vday::text) = any($1) or id in (select x->>''id'' from jsonb_array_elements($2) x)', p_table)
      using p_keys, p_rows;
    execute format('insert into %I select distinct on (id) * from jsonb_populate_recordset(null::%I, $1) on conflict (id) do nothing', p_table, p_table)
      using p_rows;
  else
    execute format('delete from %I where final = false and id in (select x->>''id'' from jsonb_array_elements($1) x)', p_table) using p_rows;
    execute format('insert into %I select distinct on (r.id) r.* from jsonb_populate_recordset(null::%I, $1) r
      where not exists (select 1 from vehicle_days d where d.id = r.vehicle_key || ''|'' || r.vday::text) on conflict (id) do nothing', p_table, p_table)
      using p_rows;
  end if;
  get diagnostics n = row_count;
  if p_table = 'fuel' and st <> '{}' then update fuel set status = st->>id where st ? id; end if;
  return n;
end $_$;

CREATE FUNCTION public.rekey_vehicle(p_alias text, p_canon text) RETURNS date
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
declare t text; d date; m date; pre text := p_alias || '|'; np integer := length(p_alias) + 2;
begin
  if p_alias = p_canon or coalesce(p_alias, '') = '' or coalesce(p_canon, '') = '' then return null; end if;
  foreach t in array array['trips', 'idles', 'events', 'fuel', 'levels', 'engine_stops'] loop
    execute format('select min(vday) from %I where vehicle_key = $1', t) into d using p_alias;
    if d is not null and (m is null or d < m) then m := d; end if;
    -- identifiant déjà présent sous la clé historique : doublon
    execute format('delete from %I a where a.vehicle_key = $1 and left(a.id, length($3)) = $3 and exists (select 1 from %I b where b.id = $2 || ''|'' || substr(a.id, $4))', t, t)
      using p_alias, p_canon, pre, np;
    execute format('update %I set vehicle_key = $2, id = case when left(id, length($3)) = $3 then $2 || ''|'' || substr(id, $4) else id end where vehicle_key = $1', t)
      using p_alias, p_canon, pre, np;
  end loop;
  update idles set trip_id = p_canon || '|' || substr(trip_id, np) where left(trip_id, length(pre)) = pre;
  update engine_stops set trip_id = p_canon || '|' || substr(trip_id, np) where left(trip_id, length(pre)) = pre;
  delete from vehicle_days a where a.vehicle_key = p_alias and exists (select 1 from vehicle_days b where b.id = p_canon || '|' || substr(a.id, np));
  update vehicle_days set vehicle_key = p_canon, id = p_canon || '|' || substr(id, np) where vehicle_key = p_alias;
  update contracts set vehicle_key = p_canon where vehicle_key = p_alias;
  update journal set vehicle_key = p_canon where vehicle_key = p_alias;
  -- alertes : identifiants qui contiennent la clé (VIT|clé|…, MOT|jour|clé…) renommés, statut, commentaire et envoi conservés
  -- (sinon le recalcul les recréait « À traiter » et les renvoyait par e-mail)
  delete from alerts a where a.vehicle_key = p_alias and position('|' || p_alias in a.id) > 0
    and exists (select 1 from alerts b where b.id = left(replace(a.id || '|', '|' || p_alias || '|', '|' || p_canon || '|'), -1));
  update alerts set vehicle_key = p_canon, id = left(replace(id || '|', '|' || p_alias || '|', '|' || p_canon || '|'), -1) where vehicle_key = p_alias;
  delete from live_status where vehicle_key = p_alias;
  return m;
end $_$;

CREATE FUNCTION public.replace_alerts(p_cut date, p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare n integer;
begin
  p_rows := coalesce(p_rows, '[]');
  delete from alerts where day >= p_cut and id not in (select x->>'id' from jsonb_array_elements(p_rows) x);
  insert into alerts (id, day, time, plate, vehicle_key, driver_code, driver_name, type, severity, detail, value, status, comment)
  select distinct on (id) id, day, time, plate, vehicle_key, driver_code, driver_name, type, severity, detail, value, 'À traiter', ''
    from jsonb_populate_recordset(null::alerts, p_rows)
  on conflict (id) do update set day = excluded.day, time = excluded.time, plate = excluded.plate, vehicle_key = excluded.vehicle_key,
    driver_code = excluded.driver_code, driver_name = excluded.driver_name, type = excluded.type, severity = excluded.severity,
    detail = excluded.detail, value = excluded.value;
  get diagnostics n = row_count; return n;
end $$;

CREATE FUNCTION public.replace_journal(p_cut date, p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare n integer;
begin
  p_rows := coalesce(p_rows, '[]');
  delete from journal where day >= p_cut or id in (select x->>'id' from jsonb_array_elements(p_rows) x);
  insert into journal select distinct on (id) * from jsonb_populate_recordset(null::journal, p_rows);
  get diagnostics n = row_count; return n;
end $$;

CREATE FUNCTION public.vehicles_agency_trg() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' and new.agency_id is null then new.agency_id := parc_agency_for(new.key, new.plate, new.other_plates); end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.alerts (
    id text NOT NULL,
    day date,
    "time" text,
    plate text,
    vehicle_key text,
    driver_code text,
    driver_name text,
    type text,
    severity text,
    detail text,
    value text,
    status text DEFAULT 'À traiter'::text NOT NULL,
    comment text DEFAULT ''::text,
    notified_at timestamp with time zone
);

CREATE TABLE public.engine_stops (
    id text NOT NULL,
    vehicle_key text NOT NULL,
    plate text,
    trip_id text,
    day date,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    dur_min double precision,
    liters double precision,
    liters_source text,
    extra_idle_min double precision,
    lph double precision,
    belt_on_min double precision,
    belt_off_min double precision,
    lat double precision,
    lon double precision,
    driver_code text,
    driver_name text,
    contract_num text,
    vday date NOT NULL,
    final boolean DEFAULT false NOT NULL
);

CREATE TABLE public.events (
    id text NOT NULL,
    vehicle_key text NOT NULL,
    plate text,
    day date,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    dur_s double precision,
    km double precision,
    rule_id text,
    rule_name text,
    driver_code text,
    driver_name text,
    contract_num text,
    vday date NOT NULL,
    final boolean DEFAULT false NOT NULL
);

CREATE TABLE public.fuel (
    id text NOT NULL,
    vehicle_key text NOT NULL,
    plate text,
    day date,
    type text,
    stop_start timestamp with time zone,
    stop_end timestamp with time zone,
    stop_min double precision,
    engine text,
    lvl_before double precision,
    lvl_after double precision,
    delta_pct double precision,
    liters_gauge double precision,
    liters_geotab double precision,
    source text,
    lat double precision,
    lon double precision,
    driver_code text,
    driver_name text,
    contract_num text,
    next_driver text,
    status text,
    vday date NOT NULL,
    final boolean DEFAULT false NOT NULL,
    check_note text
);

CREATE TABLE public.fuel_card_tx (
    id text NOT NULL,
    card text,
    vehicle_key text,
    plate text,
    at timestamp with time zone NOT NULL,
    day date,
    product text,
    liters double precision,
    unit_price double precision,
    amount_ttc double precision,
    station text,
    ticket text,
    mode text,
    invoice text,
    status text,
    note text,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    imported_by uuid
);

CREATE TABLE public.idles (
    id text NOT NULL,
    vehicle_key text NOT NULL,
    plate text,
    trip_id text,
    day date,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    stop_min double precision,
    engine_min double precision,
    engine_check text,
    liters double precision,
    liters_source text,
    lat double precision,
    lon double precision,
    driver_code text,
    driver_name text,
    contract_num text,
    vday date NOT NULL,
    final boolean DEFAULT false NOT NULL
);

CREATE TABLE public.journal (
    id text NOT NULL,
    day date,
    plate text,
    vehicle_key text,
    model text,
    driver_code text,
    driver_name text,
    contract_num text,
    contract_start timestamp with time zone,
    contract_end timestamp with time zone,
    contract_h double precision,
    n_trips integer,
    km double precision,
    drive_h double precision,
    idle_h double precision,
    idle_source text,
    long_idle_h double precision,
    n_long_idle integer,
    fuel_l double precision,
    fuel_km double precision,
    l100 double precision,
    fuel_source text,
    idle_fuel_l double precision,
    idle_fuel_source text,
    fuel_cost double precision,
    idle_cost double precision,
    vmax double precision,
    lim_at_vmax double precision,
    worst_over double precision,
    n_events integer,
    danger_pts double precision,
    score double precision,
    n_fills integer,
    fill_l double precision,
    n_siphon integer,
    siphon_l double precision,
    km_off_contract double precision
);

CREATE TABLE public.levels (
    id text NOT NULL,
    vehicle_key text NOT NULL,
    at timestamp with time zone,
    pct double precision,
    vday date NOT NULL,
    final boolean DEFAULT false NOT NULL
);

CREATE TABLE public.live_status (
    vehicle_key text NOT NULL,
    plate text,
    model text,
    state text,
    speed double precision,
    since_min double precision,
    last_pos_at timestamp with time zone,
    lat double precision,
    lon double precision,
    ign_on boolean,
    driver_name text,
    contract_num text,
    km_today double precision,
    drive_min_today double precision,
    idle_min_today double precision,
    fuel_l_today double precision,
    alerts_today integer,
    updated_at timestamp with time zone
);

CREATE TABLE public.parc (
    plate text NOT NULL,
    brand text,
    model text,
    vin text,
    fuel text,
    agency_id bigint,
    note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    agrement text,
    seats integer,
    company_id integer
);

CREATE TABLE public.plate_changes (
    id bigint NOT NULL,
    old_plate text,
    new_plate text,
    changed_on date,
    vehicle text,
    status text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.plate_changes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.plate_changes_id_seq OWNED BY public.plate_changes.id;

CREATE TABLE public.trips (
    id text NOT NULL,
    vehicle_key text NOT NULL,
    plate text,
    day date,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    km double precision,
    drive_min double precision,
    still_min double precision,
    evoff_min double precision,
    idle_min double precision,
    idle_source text,
    long_idle_min double precision,
    n_long_idle integer,
    vmax double precision,
    vavg double precision,
    vmax_gps double precision,
    lim_at_vmax double precision,
    lim_source text,
    worst_over double precision,
    speed_at_worst double precision,
    lim_at_worst double precision,
    worst_time text,
    fuel_l double precision,
    fuel_source text,
    ecu_l double precision,
    idle_fuel_l double precision,
    idle_fuel_source text,
    lat double precision,
    lon double precision,
    driver_code text,
    driver_name text,
    contract_num text,
    vday date NOT NULL,
    final boolean DEFAULT false NOT NULL,
    over_by_limit text
);

CREATE TABLE public.vehicle_days (
    id text NOT NULL,
    vehicle_key text NOT NULL,
    day date NOT NULL,
    synced_at timestamp with time zone,
    n_trips integer,
    n_events integer,
    n_levels integer,
    fuel_counter text,
    speed_limits text
);

CREATE TABLE public.vehicles (
    key text NOT NULL,
    plate text NOT NULL,
    brand text,
    model text,
    fuel text,
    vin text,
    geotab_id text,
    geotab_name text,
    tank_l double precision,
    ref_l100 double precision,
    revenue double precision,
    active text DEFAULT 'OUI'::text,
    last_sync timestamp with time zone,
    other_plates text,
    agency_id bigint
);

ALTER TABLE ONLY public.plate_changes ALTER COLUMN id SET DEFAULT nextval('public.plate_changes_id_seq'::regclass);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.engine_stops
    ADD CONSTRAINT engine_stops_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fuel_card_tx
    ADD CONSTRAINT fuel_card_tx_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fuel
    ADD CONSTRAINT fuel_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.idles
    ADD CONSTRAINT idles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.journal
    ADD CONSTRAINT journal_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.levels
    ADD CONSTRAINT levels_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.live_status
    ADD CONSTRAINT live_status_pkey PRIMARY KEY (vehicle_key);

ALTER TABLE ONLY public.parc
    ADD CONSTRAINT parc_pkey PRIMARY KEY (plate);

ALTER TABLE ONLY public.plate_changes
    ADD CONSTRAINT plate_changes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vehicle_days
    ADD CONSTRAINT vehicle_days_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (key);

CREATE INDEX alerts_day ON public.alerts USING btree (day DESC);

CREATE INDEX alerts_driver_day ON public.alerts USING btree (driver_code, day);

CREATE INDEX alerts_to_notify ON public.alerts USING btree (id) WHERE (notified_at IS NULL);

CREATE INDEX alerts_vehicle_day ON public.alerts USING btree (vehicle_key, day);

CREATE INDEX engine_stops_day ON public.engine_stops USING btree (day);

CREATE INDEX engine_stops_driver ON public.engine_stops USING btree (driver_code, day);

CREATE INDEX engine_stops_start ON public.engine_stops USING btree (start_at);

CREATE INDEX engine_stops_vday ON public.engine_stops USING btree (vehicle_key, vday);

CREATE INDEX events_contract ON public.events USING btree (contract_num);

CREATE INDEX events_day ON public.events USING btree (day);

CREATE INDEX events_driver ON public.events USING btree (driver_code, day);

CREATE INDEX events_vday ON public.events USING btree (vehicle_key, vday);

CREATE INDEX fuel_card_tx_at ON public.fuel_card_tx USING btree (at);

CREATE INDEX fuel_card_tx_vk ON public.fuel_card_tx USING btree (vehicle_key, at);

CREATE INDEX fuel_day ON public.fuel USING btree (day);

CREATE INDEX fuel_vday ON public.fuel USING btree (vehicle_key, vday);

CREATE INDEX idles_day ON public.idles USING btree (day);

CREATE INDEX idles_start ON public.idles USING btree (start_at);

CREATE INDEX idles_vday ON public.idles USING btree (vehicle_key, vday);

CREATE INDEX journal_contract ON public.journal USING btree (contract_num);

CREATE INDEX journal_day ON public.journal USING btree (day DESC);

CREATE INDEX journal_driver ON public.journal USING btree (driver_code, day);

CREATE INDEX journal_vehicle_day ON public.journal USING btree (vehicle_key, day);

CREATE INDEX levels_at ON public.levels USING btree (vehicle_key, at);

CREATE INDEX levels_vday ON public.levels USING btree (vehicle_key, vday);

CREATE INDEX trips_day ON public.trips USING btree (day);

CREATE INDEX trips_driver ON public.trips USING btree (driver_code, day);

CREATE INDEX trips_start ON public.trips USING btree (start_at);

CREATE INDEX trips_vday ON public.trips USING btree (vehicle_key, vday);

CREATE INDEX vehicle_days_day ON public.vehicle_days USING btree (day);

CREATE INDEX vehicles_agency ON public.vehicles USING btree (agency_id);

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER parc_agency AFTER INSERT OR DELETE OR UPDATE OF agency_id, plate ON public.parc FOR EACH ROW EXECUTE FUNCTION public.parc_agency_trg();

CREATE TRIGGER vehicles_agency BEFORE INSERT OR UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION public.vehicles_agency_trg();
