-- =============================================================================
-- Caisse : encaissements, dépenses, Uber, Bolt, justificatifs (structure)
-- Journal unique des mouvements (cash_moves, garde cash_guard, historique cash_log), exports Uber et Bolt,
-- fiches d'encaissement et justificatifs déposés (cash_sheets, cash_files),
-- contrôle des courses Uber (export « Activité des courses » croisé avec le GPS Geotab : uber_trips, uber_days).
-- Tables : bolt_sessions, cash_files, cash_log, cash_moves, cash_sheets, uber_days, uber_drivers, uber_payments, uber_trips
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.cash_agency_trg() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare n integer;
begin
  if new.agency_id is null then
    if tg_table_name = 'cash_moves' then
      select agency_id into new.agency_id from drivers where (code = new.driver_code or (new.uber_uuid is not null and uber_uuid = new.uber_uuid)) and agency_id is not null limit 1;
    elsif tg_table_name = 'uber_payments' then
      select agency_id into new.agency_id from drivers where uber_uuid = new.driver_uuid and agency_id is not null limit 1;
    elsif tg_table_name = 'bolt_sessions' then
      select agency_id into new.agency_id from vehicles where key = new.vehicle_key and agency_id is not null limit 1;
    else
      select agency_id into new.agency_id from drivers where uber_uuid = new.uuid and agency_id is not null limit 1;
    end if;
  end if;
  if new.agency_id is null then
    select count(*) into n from agencies;
    if n = 1 then select id into new.agency_id from agencies; elsif n > 1 then raise exception 'agence obligatoire : choisir l''agence de la caisse'; end if;
  end if;
  return new;
end $$;

CREATE FUNCTION public.cash_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare a jsonb; b jsonb;
begin
  new.updated_at := now(); new.updated_by := auth.uid();
  -- bonus : statut changé = sortie de caisse mise à jour (« Payé » en espèces = sortie ; « A payer » ou payé par banque = hors caisse)
  if tg_op = 'UPDATE' and new.kind = 'bonus' and new.status is distinct from old.status and new.status in ('Payé', 'A payer') then
    new.flow := case when new.status = 'A payer' or new.source = 'Banque' then 'virement' else 'out' end;
  end if;
  if coalesce(public.my_role(), 'service') = 'manager' then
    if tg_op = 'INSERT' then new.created_by := auth.uid(); new.created_at := now(); new.cancelled_at := null; return new; end if;
    if not (old.created_by = auth.uid() and old.created_at > now() - interval '24 hours') then
      a := to_jsonb(old) - array['justif', 'status', 'signed', 'comment', 'promo_status', 'updated_at', 'updated_by', 'flow'];
      b := to_jsonb(new) - array['justif', 'status', 'signed', 'comment', 'promo_status', 'updated_at', 'updated_by', 'flow'];
      if new.flow is distinct from old.flow and not (new.kind = 'bonus' and new.status is distinct from old.status) then
        raise exception 'saisie de plus de 24 h ou d''un autre gestionnaire : seuls le justificatif, le statut, la signature et le commentaire se modifient (correction par l''administrateur)';
      end if;
      if a is distinct from b then
        raise exception 'saisie de plus de 24 h ou d''un autre gestionnaire : seuls le justificatif, le statut, la signature et le commentaire se modifient (correction par l''administrateur)';
      end if;
    end if;
    if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'auteur et date de saisie non modifiables';
    end if;
  end if;
  return new;
end $$;

CREATE FUNCTION public.cash_log_trg() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into cash_log (move_id, by, op, old, new) values (coalesce(new.id, old.id), auth.uid(), lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end, case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  return coalesce(new, old);
end $$;

CREATE FUNCTION public.import_uber_trips(p_rows jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare adm boolean := is_admin(); keys text[] := my_vehicle_keys(); n_add integer; n_upd integer; n_same integer; n_skip integer; n_noveh integer;
begin
  if coalesce(my_role(), '') not in ('admin', 'manager') then raise exception 'droits insuffisants' using errcode = '42501'; end if;
  create temp table _u on commit drop as
    select distinct on (r.uuid) r.uuid, r.driver_uuid, r.driver_name, r.vehicle_uuid, r.plate, r.service, r.product, r.payment, r.requested_at, r.dropoff_at,
           r.pickup_addr, r.drop_addr, r.km, r.status,
           (select v.key from vehicles v where nullif(regexp_replace(coalesce(r.plate, ''), '\D', '', 'g'), '') in (regexp_replace(coalesce(v.plate, ''), '\D', '', 'g'), regexp_replace(v.key, '\D', '', 'g'))
             order by (v.key like 'myclicar:%'), v.key limit 1) as vehicle_key
      from jsonb_to_recordset(coalesce(p_rows, '[]')) as r(uuid text, driver_uuid text, driver_name text, vehicle_uuid text, plate text, service text, product text,
        payment text, requested_at timestamptz, dropoff_at timestamptz, pickup_addr text, drop_addr text, km numeric, status text)
     where coalesce(r.uuid, '') <> '' and r.requested_at is not null and coalesce(r.status, '') <> ''
     order by r.uuid;
  select count(*) filter (where vehicle_key is null) into n_noveh from _u;
  select count(*) into n_skip from _u where not adm and not (coalesce(vehicle_key, '') = any(keys));
  if not adm then delete from _u where not (coalesce(vehicle_key, '') = any(keys)); end if;
  create temp table _v on commit drop as
    select u.*, (select agency_id from vehicles where key = u.vehicle_key) as agency_id, o.uuid is not null as known,
      (o.uuid is not null and o.status = u.status and o.dropoff_at is not distinct from u.dropoff_at and o.km is not distinct from u.km
        and o.vehicle_key is not distinct from u.vehicle_key and o.pickup_addr is not distinct from u.pickup_addr) as same
      from _u u left join uber_trips o on o.uuid = u.uuid;
  select count(*) filter (where not known), count(*) filter (where known and not same), count(*) filter (where same) into n_add, n_upd, n_same from _v;
  insert into uber_trips (uuid, agency_id, driver_uuid, driver_name, vehicle_uuid, plate, vehicle_key, service, product, payment, requested_at, dropoff_at,
                          pickup_addr, drop_addr, km, status, imported_at, imported_by)
  select uuid, agency_id, driver_uuid, driver_name, vehicle_uuid, plate, vehicle_key, service, product, payment, requested_at, dropoff_at,
         pickup_addr, drop_addr, km, status, now(), auth.uid() from _v where not same
  on conflict (uuid) do update set agency_id = excluded.agency_id, driver_uuid = excluded.driver_uuid, driver_name = excluded.driver_name,
    vehicle_uuid = excluded.vehicle_uuid, plate = excluded.plate, vehicle_key = excluded.vehicle_key, service = excluded.service, product = excluded.product,
    payment = excluded.payment, requested_at = excluded.requested_at, dropoff_at = excluded.dropoff_at, drop_addr = excluded.drop_addr, km = excluded.km,
    status = excluded.status, imported_at = excluded.imported_at, imported_by = excluded.imported_by,
    pickup_addr = excluded.pickup_addr,
    pu_lat = case when uber_trips.pickup_addr is distinct from excluded.pickup_addr then null else uber_trips.pu_lat end,
    pu_lon = case when uber_trips.pickup_addr is distinct from excluded.pickup_addr then null else uber_trips.pu_lon end,
    pu_prec = case when uber_trips.pickup_addr is distinct from excluded.pickup_addr then null else uber_trips.pu_prec end,
    chk = null, chk_at = null;
  -- journées des véhicules touchés à recalculer (courses changées)
  delete from uber_days d using (select distinct vehicle_key, (requested_at at time zone 'UTC')::date as day from _v where not same and vehicle_key is not null) x
   where d.vehicle_key = x.vehicle_key and d.day between x.day - 1 and x.day + 1;
  return jsonb_build_object('added', n_add, 'updated', n_upd, 'same', n_same, 'skipped', n_skip, 'no_vehicle', n_noveh);
end $$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.bolt_sessions (
    key text NOT NULL,
    at timestamp with time zone NOT NULL,
    driver_name text,
    vehicle text,
    plate text,
    vehicle_key text,
    minutes numeric(10,2),
    online_min numeric(10,2),
    pause_min numeric(10,2),
    span text,
    trips integer DEFAULT 0 NOT NULL,
    done integer DEFAULT 0 NOT NULL,
    cancel_pax integer DEFAULT 0 NOT NULL,
    cancel_drv integer DEFAULT 0 NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    cash numeric(12,2) DEFAULT 0 NOT NULL,
    terminal numeric(12,2) DEFAULT 0 NOT NULL,
    app numeric(12,2) DEFAULT 0 NOT NULL,
    business numeric(12,2) DEFAULT 0 NOT NULL,
    raw jsonb,
    agency_id bigint,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    imported_by uuid DEFAULT auth.uid()
);

CREATE TABLE public.cash_files (
    id bigint NOT NULL,
    agency_id bigint,
    kind text NOT NULL,
    move_id bigint,
    dep_ref text,
    day date,
    category text,
    title text,
    path text NOT NULL,
    file_name text,
    drive_id text,
    drive_error text,
    drive_at timestamp with time zone,
    created_by uuid DEFAULT auth.uid(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_files_check CHECK ((((kind = 'justif'::text) AND (move_id IS NOT NULL)) OR ((kind = 'depot'::text) AND (dep_ref IS NOT NULL)))),
    CONSTRAINT cash_files_kind_check CHECK ((kind = ANY (ARRAY['justif'::text, 'depot'::text])))
);

CREATE SEQUENCE public.cash_files_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cash_files_id_seq OWNED BY public.cash_files.id;

CREATE TABLE public.cash_log (
    id bigint NOT NULL,
    move_id bigint,
    at timestamp with time zone DEFAULT now() NOT NULL,
    by uuid,
    op text,
    old jsonb,
    new jsonb
);

CREATE SEQUENCE public.cash_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cash_log_id_seq OWNED BY public.cash_log.id;

CREATE TABLE public.cash_moves (
    id bigint NOT NULL,
    caisse text NOT NULL,
    kind text NOT NULL,
    flow text NOT NULL,
    amount numeric(12,2) NOT NULL,
    day date NOT NULL,
    shift text,
    driver_code text,
    driver_name text,
    uber_uuid text,
    contract_num text,
    vehicle_key text,
    mission_id bigint,
    agency_id bigint,
    label text,
    ride_type text,
    source text,
    justif text,
    uber_cash numeric(12,2),
    given numeric(12,2),
    change numeric(12,2),
    course_amount numeric(12,2),
    commission_pct numeric(6,2),
    prime numeric(12,2),
    prime_paid numeric(12,2),
    status text,
    signed boolean,
    comment text,
    manager_name text,
    import_key text,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid DEFAULT auth.uid(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    promo numeric(12,2),
    promo_status text,
    CONSTRAINT cash_moves_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT cash_moves_caisse_check CHECK ((caisse = ANY (ARRAY['uber'::text, 'bolt'::text, 'depenses'::text, 'rh'::text, 'courses'::text, 'bonus'::text]))),
    CONSTRAINT cash_moves_flow_check CHECK ((flow = ANY (ARRAY['in'::text, 'out'::text, 'virement'::text]))),
    CONSTRAINT cash_moves_justif_check CHECK ((justif = ANY (ARRAY['OK'::text, 'KO'::text, 'N.A'::text, 'En attente'::text]))),
    CONSTRAINT cash_moves_kind_check CHECK ((kind = ANY (ARRAY['encaissement'::text, 'depense'::text, 'avance'::text, 'remboursement'::text, 'course'::text, 'bonus'::text, 'recharge'::text, 'depot'::text, 'autre'::text]))),
    CONSTRAINT cash_moves_promo_check CHECK (((promo IS NULL) OR (promo >= (0)::numeric))),
    CONSTRAINT cash_moves_promo_status_check CHECK (((promo_status IS NULL) OR (promo_status = ANY (ARRAY['À vérifier'::text, 'Payée'::text, 'Non payée'::text])))),
    CONSTRAINT cash_moves_shift_check CHECK ((shift = ANY (ARRAY['Jour'::text, 'Nuit'::text])))
);

CREATE SEQUENCE public.cash_moves_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cash_moves_id_seq OWNED BY public.cash_moves.id;

CREATE TABLE public.cash_sheets (
    id bigint NOT NULL,
    agency_id bigint,
    day date NOT NULL,
    shift text NOT NULL,
    path text NOT NULL,
    file_name text,
    note text,
    created_by uuid DEFAULT auth.uid(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_sheets_shift_check CHECK ((shift = ANY (ARRAY['Jour'::text, 'Nuit'::text])))
);

CREATE SEQUENCE public.cash_sheets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cash_sheets_id_seq OWNED BY public.cash_sheets.id;

CREATE TABLE public.uber_days (
    vehicle_key text NOT NULL,
    day date NOT NULL,
    agency_id bigint,
    win_from timestamp with time zone,
    win_to timestamp with time zone,
    km_uber numeric,
    km_off numeric,
    n_gps integer,
    segs jsonb DEFAULT '[]'::jsonb NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    computed_by uuid
);

CREATE TABLE public.uber_drivers (
    uuid text NOT NULL,
    name text,
    phone text,
    email text,
    status text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    agency_id bigint
);

CREATE TABLE public.uber_payments (
    tx text NOT NULL,
    at timestamp with time zone NOT NULL,
    driver_uuid text,
    driver_name text,
    trip text,
    description text,
    cash numeric(12,2) DEFAULT 0 NOT NULL,
    revenue numeric(12,2) DEFAULT 0 NOT NULL,
    payout numeric(12,2) DEFAULT 0 NOT NULL,
    fare numeric(12,2) DEFAULT 0 NOT NULL,
    tip numeric(12,2) DEFAULT 0 NOT NULL,
    toll numeric(12,2) DEFAULT 0 NOT NULL,
    bonus numeric(12,2) DEFAULT 0 NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    first_name text,
    last_name text,
    raw jsonb,
    agency_id bigint
);

CREATE TABLE public.uber_trips (
    uuid text NOT NULL,
    agency_id bigint,
    driver_uuid text,
    driver_name text,
    vehicle_uuid text,
    plate text,
    vehicle_key text,
    service text,
    product text,
    payment text,
    requested_at timestamp with time zone NOT NULL,
    dropoff_at timestamp with time zone,
    pickup_addr text,
    drop_addr text,
    km numeric,
    status text NOT NULL,
    pu_lat double precision,
    pu_lon double precision,
    pu_prec text,
    chk jsonb,
    chk_at timestamp with time zone,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    imported_by uuid
);

ALTER TABLE ONLY public.cash_files ALTER COLUMN id SET DEFAULT nextval('public.cash_files_id_seq'::regclass);

ALTER TABLE ONLY public.cash_log ALTER COLUMN id SET DEFAULT nextval('public.cash_log_id_seq'::regclass);

ALTER TABLE ONLY public.cash_moves ALTER COLUMN id SET DEFAULT nextval('public.cash_moves_id_seq'::regclass);

ALTER TABLE ONLY public.cash_sheets ALTER COLUMN id SET DEFAULT nextval('public.cash_sheets_id_seq'::regclass);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.bolt_sessions
    ADD CONSTRAINT bolt_sessions_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.cash_files
    ADD CONSTRAINT cash_files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cash_log
    ADD CONSTRAINT cash_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cash_moves
    ADD CONSTRAINT cash_moves_import_key_key UNIQUE (import_key);

ALTER TABLE ONLY public.cash_moves
    ADD CONSTRAINT cash_moves_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cash_sheets
    ADD CONSTRAINT cash_sheets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.uber_days
    ADD CONSTRAINT uber_days_pkey PRIMARY KEY (vehicle_key, day);

ALTER TABLE ONLY public.uber_drivers
    ADD CONSTRAINT uber_drivers_pkey PRIMARY KEY (uuid);

ALTER TABLE ONLY public.uber_payments
    ADD CONSTRAINT uber_payments_pkey PRIMARY KEY (tx);

ALTER TABLE ONLY public.uber_trips
    ADD CONSTRAINT uber_trips_pkey PRIMARY KEY (uuid);

CREATE INDEX bolt_sessions_agency ON public.bolt_sessions USING btree (agency_id, at);

CREATE INDEX bolt_sessions_at ON public.bolt_sessions USING btree (at);

CREATE INDEX cash_files_agency ON public.cash_files USING btree (agency_id);

CREATE INDEX cash_files_drive ON public.cash_files USING btree (id) WHERE (drive_id IS NULL);

CREATE INDEX cash_files_move ON public.cash_files USING btree (move_id) WHERE (move_id IS NOT NULL);

CREATE INDEX cash_files_ref ON public.cash_files USING btree (agency_id, dep_ref) WHERE (dep_ref IS NOT NULL);

CREATE INDEX cash_log_move ON public.cash_log USING btree (move_id);

CREATE INDEX cash_moves_agency ON public.cash_moves USING btree (agency_id, day);

CREATE INDEX cash_moves_day ON public.cash_moves USING btree (day);

CREATE INDEX cash_moves_driver ON public.cash_moves USING btree (driver_code, day);

CREATE INDEX cash_moves_mission ON public.cash_moves USING btree (mission_id) WHERE (mission_id IS NOT NULL);

CREATE INDEX cash_sheets_shift ON public.cash_sheets USING btree (agency_id, day, shift);

CREATE INDEX uber_days_day ON public.uber_days USING btree (day);

CREATE INDEX uber_payments_agency ON public.uber_payments USING btree (agency_id, at);

CREATE INDEX uber_payments_at ON public.uber_payments USING btree (at);

CREATE INDEX uber_payments_driver ON public.uber_payments USING btree (driver_uuid, at);

CREATE INDEX uber_trips_at ON public.uber_trips USING btree (requested_at);

CREATE INDEX uber_trips_drv ON public.uber_trips USING btree (driver_uuid, requested_at);

CREATE INDEX uber_trips_veh ON public.uber_trips USING btree (vehicle_key, requested_at);

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER bolt_sessions_agency BEFORE INSERT ON public.bolt_sessions FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();

CREATE TRIGGER cash_moves_agency BEFORE INSERT ON public.cash_moves FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();

CREATE TRIGGER cash_moves_guard BEFORE INSERT OR UPDATE ON public.cash_moves FOR EACH ROW EXECUTE FUNCTION public.cash_guard();

CREATE TRIGGER cash_moves_log AFTER INSERT OR DELETE OR UPDATE ON public.cash_moves FOR EACH ROW EXECUTE FUNCTION public.cash_log_trg();

CREATE TRIGGER uber_drivers_agency BEFORE INSERT ON public.uber_drivers FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();

CREATE TRIGGER uber_payments_agency BEFORE INSERT ON public.uber_payments FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();
