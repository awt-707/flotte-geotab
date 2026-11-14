-- =============================================================================
-- Comptes, agences et droits (structure)
-- Profils (rôle admin / manager / viewer / rh / pending), agences, rattachements, connexions en temps réel,
-- planning des gestionnaires, destinataires des alertes et des rapports. Fonctions de droits utilisées par toutes les règles RLS.
-- Tables : agencies, alert_recipients, manager_shifts, profiles, report_schedules, user_agencies, user_sessions
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.profiles(user_id, email, role)
  values (new.id, new.email, case when exists (select 1 from public.profiles) then 'pending' else 'admin' end)
  on conflict (user_id) do nothing;
  return new;
end $$;

CREATE FUNCTION public.menu_set(p_menu jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_menu is not null and (jsonb_typeof(p_menu) <> 'object' or length(p_menu::text) > 16000) then raise exception 'Réglage du menu invalide'; end if;
  update profiles set menu = p_menu where user_id = auth.uid();
end $$;

CREATE FUNCTION public.session_ping(p_id text, p_page text, p_client text, p_active boolean) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then return; end if;
  insert into user_sessions (id, page, client, active) values (p_id, left(p_page, 80), left(p_client, 80), coalesce(p_active, true))
  on conflict (id) do update set last_seen = now(), page = excluded.page, client = excluded.client, active = excluded.active
    where user_sessions.user_id = auth.uid();
  -- ménage : signaux de plus de 30 jours
  delete from user_sessions where user_id = auth.uid() and last_seen < now() - interval '30 days';
end $$;

CREATE FUNCTION public.shift_plan(p_day date, p_shift text) RETURNS TABLE(agency_id bigint, user_id uuid, email text, vehicle_key text, plate text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with ag as (
    select a.id from agencies a where (select is_admin()) or a.id = any(my_agency_ids())
  ), m as (
    select s.agency_id, s.user_id, p.email, row_number() over (partition by s.agency_id order by p.email, s.user_id) - 1 as i,
           count(*) over (partition by s.agency_id) as n
      from manager_shifts s join profiles p on p.user_id = s.user_id
     where s.day = p_day and s.shift = p_shift and s.agency_id in (select id from ag) and p.role in ('manager', 'admin')
  ), v as (
    select ve.agency_id, ve.key, ve.plate, row_number() over (partition by ve.agency_id order by ve.plate, ve.key) - 1 as j
      from vehicles ve
     where ve.agency_id in (select id from ag) and upper(coalesce(ve.active, 'OUI')) <> 'NON'
  )
  select m.agency_id, m.user_id, m.email, v.key, v.plate
    from v join m on m.agency_id = v.agency_id and m.i = v.j % m.n
   order by m.agency_id, m.email, v.plate
$$;

CREATE FUNCTION public.user_sessions_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is not null then new.last_seen := now(); end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.agencies (
    id bigint NOT NULL,
    name text NOT NULL,
    city text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cash_sheet_id text,
    rh_drive jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE public.agencies ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.agencies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.alert_recipients (
    id bigint NOT NULL,
    email text NOT NULL,
    name text,
    agency_id bigint,
    min_severity text DEFAULT 'Haute'::text NOT NULL,
    types text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alert_recipients_min_severity_check CHECK ((min_severity = ANY (ARRAY['Critique'::text, 'Haute'::text, 'Moyenne'::text, 'Info'::text])))
);

ALTER TABLE public.alert_recipients ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.alert_recipients_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.manager_shifts (
    agency_id bigint NOT NULL,
    user_id uuid NOT NULL,
    day date NOT NULL,
    shift text NOT NULL,
    CONSTRAINT manager_shifts_shift_check CHECK ((shift = ANY (ARRAY['Jour'::text, 'Nuit'::text])))
);

CREATE TABLE public.profiles (
    user_id uuid NOT NULL,
    email text,
    name text,
    role text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pages text[],
    menu jsonb,
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text, 'rh'::text, 'pending'::text])))
);

CREATE TABLE public.report_schedules (
    id bigint NOT NULL,
    name text,
    agency_id bigint,
    frequency text NOT NULL,
    recipients text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    last_period text,
    last_sent_at timestamp with time zone,
    last_result text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT report_schedules_frequency_check CHECK ((frequency = ANY (ARRAY['jour'::text, 'semaine'::text, 'mois'::text])))
);

ALTER TABLE public.report_schedules ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.report_schedules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.user_agencies (
    user_id uuid NOT NULL,
    agency_id bigint NOT NULL
);

CREATE TABLE public.user_sessions (
    id text NOT NULL,
    user_id uuid DEFAULT auth.uid() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    page text,
    client text,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT user_sessions_id_check CHECK ((id ~ '^[0-9A-Za-z-]{8,64}$'::text))
);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.agencies
    ADD CONSTRAINT agencies_name_key UNIQUE (name);

ALTER TABLE ONLY public.agencies
    ADD CONSTRAINT agencies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.alert_recipients
    ADD CONSTRAINT alert_recipients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.manager_shifts
    ADD CONSTRAINT manager_shifts_pkey PRIMARY KEY (agency_id, user_id, day, shift);

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.report_schedules
    ADD CONSTRAINT report_schedules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_agencies
    ADD CONSTRAINT user_agencies_pkey PRIMARY KEY (user_id, agency_id);

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);

CREATE INDEX manager_shifts_day ON public.manager_shifts USING btree (day, shift);

CREATE INDEX user_sessions_seen ON public.user_sessions USING btree (last_seen DESC);

CREATE INDEX user_sessions_user ON public.user_sessions USING btree (user_id, last_seen DESC);

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER user_sessions_guard BEFORE UPDATE ON public.user_sessions FOR EACH ROW EXECUTE FUNCTION public.user_sessions_guard();
