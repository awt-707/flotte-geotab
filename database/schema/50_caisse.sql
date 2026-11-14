-- =============================================================================
-- Caisse : encaissements, dépenses, Uber, Bolt, justificatifs (structure)
-- Journal unique des mouvements (cash_moves, garde cash_guard, historique cash_log), exports Uber et Bolt,
-- fiches d'encaissement et justificatifs déposés (cash_sheets, cash_files).
-- Tables : bolt_sessions, cash_files, cash_log, cash_moves, cash_sheets, uber_drivers, uber_payments
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

ALTER TABLE ONLY public.uber_drivers
    ADD CONSTRAINT uber_drivers_pkey PRIMARY KEY (uuid);

ALTER TABLE ONLY public.uber_payments
    ADD CONSTRAINT uber_payments_pkey PRIMARY KEY (tx);

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

CREATE INDEX uber_payments_agency ON public.uber_payments USING btree (agency_id, at);

CREATE INDEX uber_payments_at ON public.uber_payments USING btree (at);

CREATE INDEX uber_payments_driver ON public.uber_payments USING btree (driver_uuid, at);

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER bolt_sessions_agency BEFORE INSERT ON public.bolt_sessions FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();

CREATE TRIGGER cash_moves_agency BEFORE INSERT ON public.cash_moves FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();

CREATE TRIGGER cash_moves_guard BEFORE INSERT OR UPDATE ON public.cash_moves FOR EACH ROW EXECUTE FUNCTION public.cash_guard();

CREATE TRIGGER cash_moves_log AFTER INSERT OR DELETE OR UPDATE ON public.cash_moves FOR EACH ROW EXECUTE FUNCTION public.cash_log_trg();

CREATE TRIGGER uber_drivers_agency BEFORE INSERT ON public.uber_drivers FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();

CREATE TRIGGER uber_payments_agency BEFORE INSERT ON public.uber_payments FOR EACH ROW EXECUTE FUNCTION public.cash_agency_trg();
