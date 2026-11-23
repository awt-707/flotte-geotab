-- =============================================================================
-- Courses privées, grilles tarifaires et manifestes (structure)
-- Courses et devis (missions, validation par l'administrateur, double réservation refusée), grilles par ville de départ,
-- manifestes et sociétés émettrices (manifest_config).
-- Tables : client_feedback, manifest_config, manifests, missions, pricing_grid
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.create_feedback(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare vk text; v_ag bigint; v_plate text; v_drv text; v_ctr text; rt int; lng text; cmt text; pho text; fid bigint;
begin
  vk := nullif(left(coalesce(p->>'v', ''), 40), '');
  select agency_id, plate, key into v_ag, v_plate, vk from vehicles where vk is not null and (key = vk or upper(regexp_replace(plate, '\s', '', 'g')) = upper(regexp_replace(vk, '\s', '', 'g'))) limit 1;
  select name, num into v_drv, v_ctr from contracts where vk is not null and vehicle_key = vk and start_at <= now() and (end_at is null or end_at >= now()) order by start_at desc limit 1;
  rt := least(5, greatest(0, coalesce((p->>'rating')::int, 0)));
  lng := lower(left(coalesce(p->>'lang', ''), 5)); if lng not in ('fr', 'ar', 'it', 'de', 'en', 'es', 'pt') then lng := ''; end if;
  cmt := nullif(btrim(left(coalesce(p->>'comment', ''), 2000)), '');
  pho := p->>'photo'; if pho is not null and (left(pho, 11) <> 'data:image/' or length(pho) > 2600000) then pho := null; end if;
  if rt = 0 and cmt is null and pho is null then raise exception 'avis vide'; end if;
  insert into client_feedback (vehicle_key, plate, driver_name, contract_num, agency_id, rating, lang, comment, comment_fr, photo)
    values (vk, v_plate, v_drv, v_ctr, v_ag, nullif(rt, 0), nullif(lng, ''), cmt, case when lng = 'fr' then cmt else null end, pho)
    returning id into fid;
  return jsonb_build_object('ok', true, 'id', fid);
end $$;

CREATE FUNCTION public.create_reservation(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_enabled boolean; vk text; v_ag bigint; km numeric; mn numeric; hour int; night boolean;
  base numeric; perkm numeric; permin numeric; minfare numeric; markup numeric; nightpct numeric; nfrom numeric; nto numeric;
  raw numeric; total numeric; m_id bigint; m_num text; f jsonb; nm text; ph text; v_plate text; v_drv text; v_ctr text;
begin
  select lower(coalesce(value, 'oui')) in ('oui', 'true', '1') into v_enabled from params where key = 'resvEnabled';
  if not coalesce(v_enabled, true) then raise exception 'réservations fermées'; end if;
  nm := btrim(left(coalesce(p->>'client', ''), 120)); ph := btrim(left(coalesce(p->>'phone', ''), 40));
  if nm = '' or ph = '' then raise exception 'nom et téléphone obligatoires'; end if;
  if coalesce(p->>'destLabel', '') = '' then raise exception 'destination obligatoire'; end if;
  km := greatest(0, coalesce((p->>'km')::numeric, 0)); mn := greatest(0, coalesce((p->>'min')::numeric, 0));
  vk := nullif(left(coalesce(p->>'v', ''), 40), '');
  select agency_id, plate, key into v_ag, v_plate, vk from vehicles where vk is not null and (key = vk or upper(regexp_replace(plate, '\s', '', 'g')) = upper(regexp_replace(vk, '\s', '', 'g'))) limit 1;
  -- chauffeur présent dans la voiture au moment de la demande (contrat en cours)
  select name, num into v_drv, v_ctr from contracts where vk is not null and vehicle_key = vk and start_at <= now() and (end_at is null or end_at >= now()) order by start_at desc limit 1;
  -- tarif
  select value::numeric into base from params where key = 'resvBase';
  select value::numeric into perkm from params where key = 'resvPerKm';
  select value::numeric into permin from params where key = 'resvPerMin';
  select value::numeric into minfare from params where key = 'resvMinFare';
  select value::numeric into markup from params where key = 'resvMarkupPct';
  select value::numeric into nightpct from params where key = 'resvNightPct';
  select value::numeric into nfrom from params where key = 'resvNightFrom';
  select value::numeric into nto from params where key = 'resvNightTo';
  hour := coalesce((p->>'hour')::int, extract(hour from coalesce((p->>'when')::timestamptz, now()) at time zone 'Africa/Casablanca')::int);
  night := coalesce(nightpct, 0) > 0 and (case when coalesce(nfrom, 22) <= coalesce(nto, 6) then hour >= nfrom and hour < nto else hour >= nfrom or hour < nto end);
  raw := coalesce(base, 0) + coalesce(perkm, 0) * km + coalesce(permin, 0) * mn;
  if raw < coalesce(minfare, 0) then raw := coalesce(minfare, 0); end if;
  if night then raw := raw * (1 + coalesce(nightpct, 0) / 100); end if;
  raw := raw * (1 + coalesce(markup, 0) / 100);
  total := round(raw / 5) * 5;
  f := jsonb_build_object(
    'source', 'qr', 'origin', left(coalesce(p->>'originLabel', ''), 250), 'dest', left(coalesce(p->>'destLabel', ''), 250),
    'originLat', (p->>'originLat')::numeric, 'originLon', (p->>'originLon')::numeric, 'destLat', (p->>'destLat')::numeric, 'destLon', (p->>'destLon')::numeric,
    'distanceKm', km, 'durationMin', mn, 'night', night, 'estimate', total, 'pax', least(99, greatest(0, coalesce((p->>'pax')::int, 0))),
    'clientNote', left(coalesce(p->>'note', ''), 500), 'vehicle', vk, 'plate', v_plate, 'driverNow', v_drv, 'contractNow', v_ctr);
  insert into missions (status, agency_id, client_name, client_phone, client_email, kind, start_at, needs_validation, total_ttc,
      data, created_by)
    values ('Demande', v_ag, nm, ph, nullif(left(coalesce(p->>'email', ''), 120), ''), 'Réservation (QR)',
      (p->>'when')::timestamptz, true, total,
      jsonb_build_object('f', f, 'reservation', true, 'history', jsonb_build_array(jsonb_build_object('at', now(), 'status', 'Demande', 'by', 'réservation QR'))), null)
    returning id, number into m_id, m_num;
  return jsonb_build_object('ok', true, 'number', m_num, 'estimate', total);
end $$;

CREATE FUNCTION public.feedback_set(p_id bigint, p_status text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare s client_feedback;
begin
  if coalesce(public.my_role(), '') not in ('admin', 'manager') then raise exception 'Accès refusé'; end if;
  if p_status not in ('Nouveau', 'Traité') then raise exception 'Statut inconnu'; end if;
  select * into s from client_feedback where id = p_id;
  if s.id is null then raise exception 'Avis inconnu'; end if;
  if not public.is_admin() and not (s.agency_id = any((select public.my_agency_ids())::bigint[]) or (public.my_role() = 'manager' and s.agency_id is null)) then raise exception 'Accès refusé'; end if;
  update client_feedback set status = p_status, handled_by = auth.uid(), handled_at = now() where id = p_id;
end $$;

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

CREATE FUNCTION public.reservation_tariff(v text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with p as (select key, value from public.params where key like 'resv%'),
  veh as (select key, plate, model, agency_id from public.vehicles
    where v is not null and (key = v or upper(regexp_replace(plate, '\s', '', 'g')) = upper(regexp_replace(v, '\s', '', 'g'))) limit 1),
  drv as (select c.name, c.num from public.contracts c join veh on c.vehicle_key = veh.key
    where c.start_at <= now() and (c.end_at is null or c.end_at >= now()) order by c.start_at desc limit 1)
  select jsonb_build_object(
    'enabled', lower(coalesce((select value from p where key = 'resvEnabled'), 'oui')) in ('oui', 'true', '1'),
    'note', (select value from p where key = 'resvNote'),
    'base', coalesce((select value from p where key = 'resvBase')::numeric, 0),
    'perKm', coalesce((select value from p where key = 'resvPerKm')::numeric, 0),
    'perMin', coalesce((select value from p where key = 'resvPerMin')::numeric, 0),
    'minFare', coalesce((select value from p where key = 'resvMinFare')::numeric, 0),
    'markupPct', coalesce((select value from p where key = 'resvMarkupPct')::numeric, 0),
    'nightPct', coalesce((select value from p where key = 'resvNightPct')::numeric, 0),
    'nightFrom', coalesce((select value from p where key = 'resvNightFrom')::numeric, 22),
    'nightTo', coalesce((select value from p where key = 'resvNightTo')::numeric, 6),
    'vehicle', (select jsonb_build_object('key', key, 'plate', plate, 'model', model) from veh),
    'agency', (select a.name from public.agencies a join veh on veh.agency_id = a.id),
    'driver', (select name from drv), 'contract', (select num from drv));   -- chauffeur présent dans la voiture en ce moment (contrat en cours)
$$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.client_feedback (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vehicle_key text,
    plate text,
    driver_name text,
    contract_num text,
    agency_id bigint,
    rating integer,
    lang text,
    comment text,
    comment_fr text,
    photo text,
    status text DEFAULT 'Nouveau'::text NOT NULL,
    handled_by uuid,
    handled_at timestamp with time zone,
    CONSTRAINT client_feedback_rating_check CHECK (((rating >= 0) AND (rating <= 5))),
    CONSTRAINT client_feedback_status_check CHECK ((status = ANY (ARRAY['Nouveau'::text, 'Traité'::text])))
);

CREATE SEQUENCE public.client_feedback_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.client_feedback_id_seq OWNED BY public.client_feedback.id;

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

ALTER TABLE ONLY public.client_feedback ALTER COLUMN id SET DEFAULT nextval('public.client_feedback_id_seq'::regclass);

ALTER TABLE ONLY public.manifest_config ALTER COLUMN id SET DEFAULT nextval('public.manifest_config_id_seq'::regclass);

ALTER TABLE ONLY public.manifests ALTER COLUMN id SET DEFAULT nextval('public.manifests_id_seq'::regclass);

ALTER TABLE ONLY public.missions ALTER COLUMN id SET DEFAULT nextval('public.missions_id_seq'::regclass);

ALTER TABLE ONLY public.pricing_grid ALTER COLUMN id SET DEFAULT nextval('public.pricing_grid_id_seq'::regclass);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.client_feedback
    ADD CONSTRAINT client_feedback_pkey PRIMARY KEY (id);

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

CREATE INDEX client_feedback_ag ON public.client_feedback USING btree (agency_id, created_at DESC);

CREATE INDEX client_feedback_at ON public.client_feedback USING btree (created_at DESC);

CREATE INDEX client_feedback_todo ON public.client_feedback USING btree (status) WHERE (status = 'Nouveau'::text);

CREATE INDEX client_feedback_tr ON public.client_feedback USING btree (id) WHERE ((comment IS NOT NULL) AND (comment_fr IS NULL));

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
