-- =============================================================================
-- Courses privées, grilles tarifaires et manifestes (structure)
-- Courses et devis (missions, validation par l'administrateur, double réservation refusée), grilles par ville de départ,
-- manifestes et sociétés émettrices (manifest_config).
-- Tables : manifest_config, manifests, missions, pricing_grid
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.manifest_config_keep() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.id = 1 then raise exception 'société principale : ne peut pas être retirée'; end if;
  return old;
end $$;

CREATE FUNCTION public.mission_booking() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare o record;
begin
  if new.vehicle_key is null or new.start_at is null or new.status not in ('Acompte reçu', 'Confirmée', 'En cours') then return new; end if;
  if tg_op = 'UPDATE' and new.vehicle_key is not distinct from old.vehicle_key and new.start_at is not distinct from old.start_at
     and new.end_at is not distinct from old.end_at and new.status is not distinct from old.status then return new; end if;
  perform pg_advisory_xact_lock(hashtext('mission:' || new.vehicle_key));   -- deux confirmations en même temps : l'une après l'autre
  select m.number, m.status, m.client_name into o from public.missions m
   where m.vehicle_key = new.vehicle_key and m.id is distinct from new.id and m.status in ('Acompte reçu', 'Confirmée', 'En cours')
     and m.start_at < coalesce(new.end_at, new.start_at) and coalesce(m.end_at, m.start_at) > new.start_at
   limit 1;
  if found then raise exception 'véhicule déjà bloqué sur cette période : % (%, %)', coalesce(o.number, '?'), coalesce(o.client_name, ''), o.status; end if;
  return new;
end $$;

CREATE FUNCTION public.mission_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare lim numeric;
begin
  if coalesce(public.my_role(), 'service') = 'manager' then
    if tg_op = 'INSERT' and (new.validated_by is not null or new.validated_at is not null) then
      raise exception 'validation réservée à l''administrateur';
    end if;
    if tg_op = 'UPDATE' and (new.validated_by is distinct from old.validated_by or new.validated_at is distinct from old.validated_at) then
      raise exception 'validation réservée à l''administrateur';
    end if;
    -- besoin de validation : jamais retiré par un gestionnaire ; règles connues de la base (24 h / VIP, plus de 3 jours, montant)
    select nullif(data->>'validationAmount', '')::numeric into lim from public.pricing_grid where id = 1;
    -- devis préparé par un gestionnaire : toujours validé (réajusté au besoin) par l'administrateur ; la course rapide (sans devis) non
    new.needs_validation := coalesce(new.needs_validation, false) or (tg_op = 'UPDATE' and coalesce(old.needs_validation, false))
      or (coalesce(new.data->>'quick', '') <> 'true' and (tg_op = 'INSERT' or old.status = 'Demande'))   -- devis déjà envoyés avant cette règle : inchangés
      or coalesce(new.level = '24h / VIP', false) or coalesce((new.end_at - new.start_at) > interval '3 days', false) or coalesce(lim > 0 and new.total_ttc > lim, false);
    -- devis à valider : pas d'envoi ni de confirmation tant que l'administrateur n'a pas validé
    if new.needs_validation and new.validated_at is null and new.status not in ('Demande', 'Annulée', 'Refusée') then
      raise exception 'validation de l''exploitation requise avant « % »', new.status;
    end if;
  end if;
  -- mission modifiée après validation (prix, dates, véhicule, niveau, détail du prix) : la validation tombe, à refaire
  if tg_op = 'UPDATE' and old.validated_at is not null and new.validated_at is not distinct from old.validated_at
     and (new.total_ttc is distinct from old.total_ttc or new.start_at is distinct from old.start_at or new.end_at is distinct from old.end_at
          or new.category is distinct from old.category or new.level is distinct from old.level or new.vehicle_key is distinct from old.vehicle_key
          or (new.data -> 'price' -> 'lines') is distinct from (old.data -> 'price' -> 'lines')) then
    if coalesce(public.my_role(), '') = 'manager' and new.needs_validation and new.status not in ('Demande', 'Annulée', 'Refusée') then
      raise exception 'devis validé par l''exploitation : prix, dates, véhicule et niveau modifiables seulement par l''administrateur';
    end if;
    new.validated_at := null; new.validated_by := null;
  end if;
  return new;
end $$;

CREATE FUNCTION public.mission_number() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if new.number is null then new.number := 'DEV-' || to_char(now() at time zone 'Africa/Casablanca', 'YYYY') || '-' || lpad(nextval('public.mission_number_seq')::text, 4, '0'); end if;
  new.updated_at := now();
  return new;
end $$;

CREATE FUNCTION public.mission_quick_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if coalesce(public.my_role(), 'service') = 'manager' then
    if tg_op = 'INSERT' and coalesce(new.data->>'quick', '') = 'true' and new.status not in ('Confirmée', 'En cours') then
      raise exception 'course rapide : créée « Confirmée » ou « En cours » seulement (sinon, préparer un devis)';
    end if;
    if tg_op = 'UPDATE' and coalesce(new.data->>'quick', '') is distinct from coalesce(old.data->>'quick', '') then
      raise exception 'course rapide : marque non modifiable';
    end if;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.manifest_config (
    id integer NOT NULL,
    company jsonb DEFAULT '{}'::jsonb NOT NULL,
    email_to text,
    stamp text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active boolean DEFAULT true NOT NULL
);

CREATE SEQUENCE public.manifest_config_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.manifest_config_id_seq OWNED BY public.manifest_config.id;

CREATE TABLE public.manifests (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid DEFAULT auth.uid(),
    vehicle_key text,
    plate text,
    driver_name text,
    driver_phone text,
    client text,
    depart_at timestamp with time zone,
    file_name text,
    file_path text,
    message text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE SEQUENCE public.manifests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.manifests_id_seq OWNED BY public.manifests.id;

CREATE SEQUENCE public.mission_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.missions (
    id bigint NOT NULL,
    number text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid DEFAULT auth.uid(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'Demande'::text NOT NULL,
    agency_id bigint,
    client_name text,
    client_company text,
    client_phone text,
    client_email text,
    kind text,
    category text,
    vehicle_key text,
    driver_name text,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    level text,
    needs_validation boolean DEFAULT false NOT NULL,
    validated_by uuid,
    validated_at timestamp with time zone,
    total_ttc double precision,
    deposit double precision,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT missions_status_check CHECK ((status = ANY (ARRAY['Demande'::text, 'Devis envoyé'::text, 'Accepté'::text, 'Acompte reçu'::text, 'Confirmée'::text, 'En cours'::text, 'Terminée'::text, 'Facturée'::text, 'Annulée'::text, 'Refusée'::text])))
);

CREATE SEQUENCE public.missions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.missions_id_seq OWNED BY public.missions.id;

CREATE TABLE public.pricing_grid (
    id integer NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    name text,
    agency_id bigint
);

CREATE SEQUENCE public.pricing_grid_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.pricing_grid_id_seq OWNED BY public.pricing_grid.id;

ALTER TABLE ONLY public.manifest_config ALTER COLUMN id SET DEFAULT nextval('public.manifest_config_id_seq'::regclass);

ALTER TABLE ONLY public.manifests ALTER COLUMN id SET DEFAULT nextval('public.manifests_id_seq'::regclass);

ALTER TABLE ONLY public.missions ALTER COLUMN id SET DEFAULT nextval('public.missions_id_seq'::regclass);

ALTER TABLE ONLY public.pricing_grid ALTER COLUMN id SET DEFAULT nextval('public.pricing_grid_id_seq'::regclass);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.manifest_config
    ADD CONSTRAINT manifest_config_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.manifests
    ADD CONSTRAINT manifests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.missions
    ADD CONSTRAINT missions_number_key UNIQUE (number);

ALTER TABLE ONLY public.missions
    ADD CONSTRAINT missions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pricing_grid
    ADD CONSTRAINT pricing_grid_pkey PRIMARY KEY (id);

CREATE INDEX manifests_created ON public.manifests USING btree (created_at DESC);

CREATE INDEX manifests_file ON public.manifests USING btree (file_path);

CREATE INDEX manifests_vehicle ON public.manifests USING btree (vehicle_key);

CREATE INDEX missions_start ON public.missions USING btree (start_at);

CREATE INDEX missions_vk ON public.missions USING btree (vehicle_key, start_at);

CREATE UNIQUE INDEX pricing_grid_name ON public.pricing_grid USING btree (lower(name));

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER manifest_config_keep BEFORE DELETE ON public.manifest_config FOR EACH ROW EXECUTE FUNCTION public.manifest_config_keep();

CREATE TRIGGER mission_quick_guard BEFORE INSERT OR UPDATE ON public.missions FOR EACH ROW EXECUTE FUNCTION public.mission_quick_guard();

CREATE TRIGGER missions_booking BEFORE INSERT OR UPDATE ON public.missions FOR EACH ROW EXECUTE FUNCTION public.mission_booking();

CREATE TRIGGER missions_guard BEFORE INSERT OR UPDATE ON public.missions FOR EACH ROW EXECUTE FUNCTION public.mission_guard();

CREATE TRIGGER missions_number BEFORE INSERT OR UPDATE ON public.missions FOR EACH ROW EXECUTE FUNCTION public.mission_number();
