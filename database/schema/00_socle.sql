-- =============================================================================
-- Socle : fonctions de droits, paramètres, demandes du site, journal technique, versions du collecteur, suivi des limites (structure)
-- Fonctions de droits (is_admin, my_role, my_vehicle_keys, rh_scope, plan_can_edit…), paramètres (params), règles de score (rules), demandes du site au collecteur (jobs), journal technique (logs),
-- versions du collecteur (releases), compteurs d'usage (usage_daily), session Geotab du relais, coffre des intégrations.
-- Tables : geotab_session, integration_secrets, jobs, logs, params, releases, rules, usage_daily
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- Droits par défaut retirés pendant l'installation (remis à la fin de liens_droits/00_socle.sql)
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.bump_usage(p_kind text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  insert into usage_daily (day, kind, n) values ((now() + interval '1 hour')::date, p_kind, 1)
  on conflict (day, kind) do update set n = usage_daily.n + 1
$$;

CREATE FUNCTION public.cash_folder_ok(f text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  select f ~ '^\d+$' and (public.is_admin() or (public.my_role() = 'manager' and (
    (f <> '0' and f::bigint = any(public.my_agency_ids()::bigint[])) or (f = '0' and not exists (select 1 from agencies)))))
$_$;

CREATE FUNCTION public.db_size() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select jsonb_build_object('total_mb', round(pg_database_size(current_database()) / 1048576.0, 1),
    'tables', (select jsonb_object_agg(relname, round(pg_total_relation_size(c.oid) / 1048576.0, 2)) from pg_class c
                join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'))
$$;

CREATE FUNCTION public.hr_can(p_kind text, p_agency bigint) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select public.rh_scope(p_agency) or (p_kind = 'chauffeur' and public.my_role() = 'manager' and p_agency = any(public.my_agency_ids())
    and coalesce((select value from public.params where key = 'rhManagers'), 'oui') <> 'non')
$$;

CREATE FUNCTION public.hr_can_emp(p_id bigint) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (select 1 from public.hr_employees e where e.id = p_id and public.hr_can(e.kind, e.agency_id))
$$;

CREATE FUNCTION public.integration_set(p_name text, p_value text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
begin
  if not public.is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_name not in ('bolt_client_id', 'bolt_client_secret', 'bolt_company_id', 'uber_client_id', 'uber_client_secret') then raise exception 'réglage inconnu : %', p_name; end if;
  if p_value is null or btrim(p_value) = '' then delete from integration_secrets where name = p_name; return; end if;
  if p_name = 'bolt_company_id' and btrim(p_value) !~ '^\d+(\s*,\s*\d+)*$' then raise exception 'numéro de société Bolt : chiffres seulement (plusieurs séparés par des virgules)'; end if;
  insert into integration_secrets (name, value, updated_at, updated_by) values (p_name, btrim(p_value), now(), auth.uid())
    on conflict (name) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end $_$;

CREATE FUNCTION public.integration_status() RETURNS TABLE(name text, updated_at timestamp with time zone, shown text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then raise exception 'réservé à l''administrateur'; end if;
  return query select s.name, s.updated_at, case when s.name like '%secret%' then null else s.value end from integration_secrets s order by s.name;
end $$;

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((select role = 'admin' from profiles where user_id = auth.uid()), false)
$$;

CREATE FUNCTION public.is_rh() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((select role = 'rh' from profiles where user_id = auth.uid()), false)
$$;

CREATE FUNCTION public.my_agency_ids() RETURNS bigint[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(array_agg(agency_id), '{}') from user_agencies
   where user_id = auth.uid() and (select role from profiles where user_id = auth.uid()) in ('manager', 'viewer')
$$;

CREATE FUNCTION public.my_driver_codes() RETURNS text[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(array_agg(distinct code), '{}') from (
    select code from drivers where agency_id = any(my_agency_ids())
    union all select client_code from contracts where vehicle_key = any(my_vehicle_keys()) and client_code is not null) x
$$;

CREATE FUNCTION public.my_role() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select role from public.profiles where user_id = auth.uid()
$$;

CREATE FUNCTION public.my_vehicle_keys() RETURNS text[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(array_agg(key), '{}') from vehicles
   where (select role from profiles where user_id = auth.uid()) in ('manager', 'viewer')
     and agency_id = any(coalesce((select array_agg(agency_id) from user_agencies where user_id = auth.uid()), '{}'))
$$;

CREATE FUNCTION public.name_key(t text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select coalesce(string_agg(w, ' ' order by w), '') from (select norm_name(x) w from regexp_split_to_table(coalesce(t, ''), '\s+') x) y where w <> ''
$$;

CREATE FUNCTION public.norm_name(t text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select regexp_replace(lower(translate(coalesce(t, ''), 'ÀÂÄÁÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÇÑàâäáãéèêëíìîïóòôöõúùûüçñ', 'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn')), '[^a-z]', '', 'g')
$$;

CREATE FUNCTION public.norm_plate(s text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select regexp_replace(t, '[^0-9]', '', 'g') || regexp_replace(t, '[^A-Z]', '', 'g') from (select regexp_replace(upper(coalesce(s, '')), '[^0-9A-Z]', '', 'g') t) x
$$;

CREATE FUNCTION public.plan_can_edit(p_agency bigint, p_week date DEFAULT NULL::date) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(is_admin(), false) or (p_agency is not null and coalesce(
    my_role() = 'manager' and p_agency = any(my_agency_ids())
    and coalesce((select value from params where key = 'planManagersEdit'), 'oui') <> 'non'
    and (p_week is null or not exists (select 1 from plan_weeks w where w.agency_id = p_agency and w.week = p_week and w.locked)), false))
$$;

CREATE FUNCTION public.plan_can_read(p_agency bigint) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select is_admin() or p_agency = any(my_agency_ids())
$$;

CREATE FUNCTION public.plan_driver_in(p_code text, p_agency bigint) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(is_admin(), false) or (p_agency is not null and coalesce(
    coalesce((select agency_id from driver_roster where driver_code = p_code), (select agency_id from drivers where code = p_code), p_agency) = p_agency, false))
$$;

CREATE FUNCTION public.rh_agency_ids() RETURNS bigint[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(array_agg(agency_id), '{}') from user_agencies where user_id = auth.uid() and public.is_rh()
$$;

CREATE FUNCTION public.rh_driver_codes() RETURNS text[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(array_agg(e.driver_code), '{}') from public.hr_employees e left join public.drivers d on d.code = e.driver_code
   where public.is_rh() and e.driver_code is not null and public.rh_scope(e.agency_id) and public.rh_scope(d.agency_id)
$$;

CREATE FUNCTION public.rh_scope(p_agency bigint) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select public.is_admin() or (public.is_rh() and (p_agency is null or cardinality(public.rh_agency_ids()) = 0 or p_agency = any(public.rh_agency_ids())))
$$;

CREATE FUNCTION public.rh_staff_users() RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(array_agg(e.user_id), '{}') from public.hr_employees e join public.profiles p on p.user_id = e.user_id
   where public.is_rh() and e.kind = 'staff' and p.role <> 'admin' and public.rh_scope(e.agency_id)
$$;

CREATE FUNCTION public.usage_stats() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare st jsonb := '{}'::jsonb; m date := date_trunc('month', now() + interval '1 hour')::date;
begin
  if not (is_admin() or coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role') then
    raise exception 'réservé à l''administrateur';
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'select coalesce(jsonb_object_agg(bucket_id, mb), ''{}''::jsonb) from (select bucket_id, round(sum(coalesce((metadata->>''size'')::bigint, 0)) / 1048576.0, 1) mb
      from storage.objects group by bucket_id) x' into st;
  end if;
  return jsonb_build_object(
    'db_mb', round(pg_database_size(current_database()) / 1048576.0, 1),
    'storage_mb', st,
    'live_month', (select coalesce(sum(n), 0) from usage_daily where kind = 'live' and day >= m),
    'live_since', (select min(day) from usage_daily where kind = 'live' and day >= m),
    'live_days', (select count(*) from usage_daily where kind = 'live' and day >= m),
    'month', m);
end $$;

CREATE FUNCTION public.wc_can(p_agency bigint) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select public.rh_scope(p_agency) or (public.my_role() = 'manager' and p_agency = any(public.my_agency_ids())
    and coalesce((select value from public.params where key = 'rhManagers'), 'oui') <> 'non')
$$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.geotab_session (
    id integer DEFAULT 1 NOT NULL,
    server text,
    credentials jsonb,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT geotab_session_id_check CHECK ((id = 1))
);

CREATE TABLE public.integration_secrets (
    name text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE public.jobs (
    id bigint NOT NULL,
    kind text NOT NULL,
    arg text,
    created_by uuid DEFAULT auth.uid(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    done_at timestamp with time zone,
    result text
);

CREATE SEQUENCE public.jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.jobs_id_seq OWNED BY public.jobs.id;

CREATE TABLE public.logs (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    action text,
    detail text,
    dur_s double precision
);

CREATE SEQUENCE public.logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.logs_id_seq OWNED BY public.logs.id;

CREATE TABLE public.params (
    key text NOT NULL,
    label text,
    value text,
    note text,
    sort integer
);

CREATE TABLE public.releases (
    id bigint NOT NULL,
    version text NOT NULL,
    sha text NOT NULL,
    files jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.releases ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.releases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.rules (
    id text NOT NULL,
    name text,
    weight double precision DEFAULT 0,
    category text,
    n_events integer,
    note text
);

CREATE TABLE public.usage_daily (
    day date NOT NULL,
    kind text NOT NULL,
    n bigint DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.jobs ALTER COLUMN id SET DEFAULT nextval('public.jobs_id_seq'::regclass);

ALTER TABLE ONLY public.logs ALTER COLUMN id SET DEFAULT nextval('public.logs_id_seq'::regclass);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.geotab_session
    ADD CONSTRAINT geotab_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.integration_secrets
    ADD CONSTRAINT integration_secrets_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.logs
    ADD CONSTRAINT logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.params
    ADD CONSTRAINT params_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_sha_key UNIQUE (sha);

ALTER TABLE ONLY public.rules
    ADD CONSTRAINT rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.usage_daily
    ADD CONSTRAINT usage_daily_pkey PRIMARY KEY (day, kind);

CREATE INDEX logs_at ON public.logs USING btree (at DESC);
