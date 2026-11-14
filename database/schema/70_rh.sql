-- =============================================================================
-- Ressources humaines et contrats de travail (structure)
-- Salariés (chauffeurs et staff), événements (congés, absences, avances, avenants…), pointage du staff, dossiers,
-- sociétés employeuses et contrats de travail. Rôle « rh » limité ou non à des agences (rh_scope).
-- Tables : employers, hr_clock, hr_documents, hr_employees, hr_events, work_contracts
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.employers_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin new.updated_at := now(); return new; end $$;

CREATE FUNCTION public.hr_clock_do(p_kind text, p_birth date DEFAULT NULL::date, p_client text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare e public.hr_employees; st text; n int;
begin
  select * into e from public.hr_employees where user_id = auth.uid() and (left_on is null or left_on > current_date) and pointage;
  if e.id is null then return jsonb_build_object('ok', false, 'error', 'Pointage non activé pour ce compte'); end if;
  if p_kind not in ('in', 'pause', 'resume', 'out') then return jsonb_build_object('ok', false, 'error', 'Action inconnue'); end if;
  perform pg_advisory_xact_lock(hashtext('hr_clock_do'), e.id::int);   -- un appel à la fois par salarié
  st := public.hr_state(e.id) ->> 'state';
  if p_kind = 'in' then
    -- ouverture de Ludy : date de naissance obligatoire, 5 essais manqués en 15 minutes au plus
    select count(*) into n from public.hr_clock where employee_id = e.id and kind = 'fail' and at > now() - interval '15 minutes';
    if n >= 5 then return jsonb_build_object('ok', false, 'error', 'Trop d''essais : réessayez dans 15 minutes'); end if;
    if e.birth_date is null then return jsonb_build_object('ok', false, 'error', 'Date de naissance absente de la fiche : demandez à l''administrateur de la renseigner'); end if;
    if p_birth is distinct from e.birth_date then
      insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'fail', left(p_client, 80));
      return jsonb_build_object('ok', false, 'error', 'Date de naissance incorrecte');
    end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), case when st = 'off' then 'in' else 'session' end, left(p_client, 80));
  elsif p_kind = 'pause' then
    if st <> 'on' then return jsonb_build_object('ok', false, 'error', 'Pause possible seulement en service'); end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'pause', left(p_client, 80));
  elsif p_kind = 'resume' then
    if st <> 'pause' then return jsonb_build_object('ok', false, 'error', 'Aucune pause en cours'); end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'resume', left(p_client, 80));
  else
    if st = 'off' then return jsonb_build_object('ok', false, 'error', 'Aucune journée en cours'); end if;
    insert into public.hr_clock (employee_id, user_id, kind, client) values (e.id, auth.uid(), 'out', left(p_client, 80));
  end if;
  return jsonb_build_object('ok', true) || public.hr_me();
end $$;

CREATE FUNCTION public.hr_me() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select case when e.id is null then null else jsonb_build_object('id', e.id, 'name', e.name, 'kind', e.kind, 'pointage', e.pointage) || public.hr_state(e.id) end
  from (select 1) x left join public.hr_employees e on e.user_id = auth.uid() and (e.left_on is null or e.left_on > current_date)
$$;

CREATE FUNCTION public.hr_state(p_emp bigint) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with arr as (
    select max(at) as at from public.hr_clock where employee_id = p_emp and kind = 'in' and at > now() - interval '18 hours'),
  last as (
    select c.kind, c.at from public.hr_clock c, arr where c.employee_id = p_emp and c.kind in ('in', 'pause', 'resume', 'out') and arr.at is not null and c.at >= arr.at
    order by c.at desc, c.id desc limit 1)
  select jsonb_build_object(
    'state', case (select kind from last) when 'in' then 'on' when 'resume' then 'on' when 'pause' then 'pause' else 'off' end,
    'since', (select at from last),
    'arrived', case when (select kind from last) in ('in', 'pause', 'resume') then (select at from arr) end)
$$;

CREATE FUNCTION public.hr_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'INSERT' then new.created_by := auth.uid(); new.created_at := now();
  else new.created_by := old.created_by; new.created_at := old.created_at; end if;
  new.updated_at := now();
  return new;
end $$;

CREATE FUNCTION public.hr_user_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.user_id is not null and new.user_id is distinct from (case when tg_op = 'UPDATE' then old.user_id end) and auth.uid() is not null and not is_admin()
     and exists (select 1 from profiles where user_id = new.user_id and role = 'admin') then
    raise exception 'compte administrateur : rattachement réservé à l''administrateur';
  end if;
  return new;
end $$;

CREATE FUNCTION public.rh_drive_reset() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_table_name = 'work_contracts' then
    if new.pdf_path is distinct from old.pdf_path then new.drive_pdf_id := null; end if;
    if new.legal_path is distinct from old.legal_path then new.drive_legal_id := null; end if;
  elsif new.doc_path is distinct from old.doc_path then new.drive_doc_id := null;
  end if;
  return new;
end $$;

CREATE FUNCTION public.rh_drive_set(p_agency bigint, p_data jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare k text; v text; d jsonb := '{}'::jsonb; pk text;
begin
  if not (public.is_admin() or (public.is_rh() and public.rh_scope(p_agency) and (p_agency is not null or cardinality(public.rh_agency_ids()) = 0))) then
    raise exception 'Réservé à l''administrateur et aux comptes Ressources humaines de l''agence';
  end if;
  foreach k in array array['contracts', 'payroll', 'clock'] loop
    v := coalesce(substring(coalesce(p_data ->> k, '') from '[-_A-Za-z0-9]{20,}'), '');
    if p_agency is null then
      pk := case k when 'contracts' then 'rhDriveContracts' when 'payroll' then 'rhDrivePayroll' else 'rhDriveClock' end;
      insert into params (key, value) values (pk, v) on conflict (key) do update set value = excluded.value;
    elsif v <> '' then d := d || jsonb_build_object(k, v);
    end if;
  end loop;
  if p_agency is not null then
    update agencies set rh_drive = d where id = p_agency;
    if not found then raise exception 'Agence inconnue'; end if;
  end if;
  return d;
end $$;

CREATE FUNCTION public.work_contracts_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'INSERT' then new.created_by := auth.uid(); new.created_at := now();
  else new.created_by := old.created_by; new.created_at := old.created_at; end if;
  new.updated_at := now();
  return new;
end $$;

SET default_tablespace = '';

SET default_table_access_method = heap;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.employers (
    id bigint NOT NULL,
    name text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.employers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.employers_id_seq OWNED BY public.employers.id;

CREATE TABLE public.hr_clock (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    user_id uuid,
    kind text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    client text,
    note text,
    created_by uuid DEFAULT auth.uid(),
    CONSTRAINT hr_clock_kind_check CHECK ((kind = ANY (ARRAY['in'::text, 'pause'::text, 'resume'::text, 'out'::text, 'session'::text, 'fail'::text])))
);

CREATE SEQUENCE public.hr_clock_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.hr_clock_id_seq OWNED BY public.hr_clock.id;

CREATE TABLE public.hr_documents (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    category text NOT NULL,
    label text,
    path text NOT NULL,
    issued_on date,
    expires_on date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hr_documents_category_check CHECK ((category = ANY (ARRAY['contrat'::text, 'avenant'::text, 'cin'::text, 'permis'::text, 'carte_pro'::text, 'casier'::text, 'cnss'::text, 'rib'::text, 'diplome'::text, 'medical'::text, 'photo'::text, 'attestation'::text, 'autre'::text])))
);

CREATE SEQUENCE public.hr_documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.hr_documents_id_seq OWNED BY public.hr_documents.id;

CREATE TABLE public.hr_employees (
    id bigint NOT NULL,
    kind text NOT NULL,
    employer_id bigint,
    agency_id bigint,
    driver_code text,
    user_id uuid,
    name text NOT NULL,
    cin text,
    birth_date date,
    phone text,
    email text,
    "position" text,
    hired_on date,
    trial_months numeric(4,2) DEFAULT 1.5 NOT NULL,
    trial_renewable boolean DEFAULT true NOT NULL,
    trial_decision text,
    trial_decided_on date,
    salary numeric(12,2),
    weekly_hours numeric(5,2) DEFAULT 44 NOT NULL,
    leave_per_month numeric(4,2) DEFAULT 1.5 NOT NULL,
    pointage boolean DEFAULT false NOT NULL,
    work_contract_id bigint,
    left_on date,
    left_reason text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cnss_no text,
    contract_type text DEFAULT 'CDI'::text NOT NULL,
    contract_end date,
    category text,
    work_start time without time zone,
    work_days text DEFAULT '1,2,3,4,5,6'::text NOT NULL,
    CONSTRAINT hr_employees_category_check CHECK (((category IS NULL) OR (category = ANY (ARRAY['cadre'::text, 'employe'::text, 'ouvrier'::text])))),
    CONSTRAINT hr_employees_check CHECK (((kind = 'staff'::text) OR ((user_id IS NULL) AND (NOT pointage)))),
    CONSTRAINT hr_employees_check1 CHECK (((kind = 'chauffeur'::text) OR (driver_code IS NULL))),
    CONSTRAINT hr_employees_contract_type_check CHECK ((contract_type = ANY (ARRAY['CDI'::text, 'CDD'::text, 'ANAPEC'::text, 'Stage'::text, 'Autre'::text]))),
    CONSTRAINT hr_employees_kind_check CHECK ((kind = ANY (ARRAY['chauffeur'::text, 'staff'::text]))),
    CONSTRAINT hr_employees_leave_per_month_check CHECK (((leave_per_month >= (0)::numeric) AND (leave_per_month <= (5)::numeric))),
    CONSTRAINT hr_employees_salary_check CHECK ((salary >= (0)::numeric)),
    CONSTRAINT hr_employees_trial_decision_check CHECK ((trial_decision = ANY (ARRAY['renouvelée'::text, 'confirmée'::text, 'rompue'::text]))),
    CONSTRAINT hr_employees_trial_months_check CHECK (((trial_months >= (0)::numeric) AND (trial_months <= (12)::numeric))),
    CONSTRAINT hr_employees_weekly_hours_check CHECK (((weekly_hours > (0)::numeric) AND (weekly_hours <= (80)::numeric))),
    CONSTRAINT hr_employees_work_days_check CHECK ((work_days ~ '^([1-7](,[1-7])*)?$'::text))
);

CREATE SEQUENCE public.hr_employees_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.hr_employees_id_seq OWNED BY public.hr_employees.id;

CREATE TABLE public.hr_events (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    kind text NOT NULL,
    day_from date NOT NULL,
    day_to date,
    days numeric(6,2),
    amount numeric(12,2),
    new_salary numeric(12,2),
    justified boolean,
    status text,
    label text,
    doc_path text,
    plan_absence_id bigint,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    drive_doc_id text,
    CONSTRAINT hr_events_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT hr_events_check CHECK (((day_to IS NULL) OR (day_to >= day_from))),
    CONSTRAINT hr_events_days_check CHECK ((days >= (0)::numeric)),
    CONSTRAINT hr_events_kind_check CHECK ((kind = ANY (ARRAY['conge'::text, 'maladie'::text, 'absence'::text, 'avance'::text, 'remboursement'::text, 'prime'::text, 'avenant'::text, 'autre'::text]))),
    CONSTRAINT hr_events_new_salary_check CHECK ((new_salary >= (0)::numeric))
);

CREATE SEQUENCE public.hr_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.hr_events_id_seq OWNED BY public.hr_events.id;

CREATE TABLE public.work_contracts (
    id bigint NOT NULL,
    employer_id bigint,
    agency_id bigint,
    driver_code text,
    name text,
    cin text,
    effective_on date,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    pdf_path text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    employee_id bigint,
    signed_on date,
    legalized_on date,
    legal_place text,
    legal_path text,
    external boolean DEFAULT false NOT NULL,
    ended_on date,
    drive_pdf_id text,
    drive_legal_id text,
    model text DEFAULT 'chauffeur'::text NOT NULL,
    CONSTRAINT work_contracts_model_check CHECK ((model = ANY (ARRAY['chauffeur'::text, 'staff'::text])))
);

CREATE SEQUENCE public.work_contracts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.work_contracts_id_seq OWNED BY public.work_contracts.id;

ALTER TABLE ONLY public.employers ALTER COLUMN id SET DEFAULT nextval('public.employers_id_seq'::regclass);

ALTER TABLE ONLY public.hr_clock ALTER COLUMN id SET DEFAULT nextval('public.hr_clock_id_seq'::regclass);

ALTER TABLE ONLY public.hr_documents ALTER COLUMN id SET DEFAULT nextval('public.hr_documents_id_seq'::regclass);

ALTER TABLE ONLY public.hr_employees ALTER COLUMN id SET DEFAULT nextval('public.hr_employees_id_seq'::regclass);

ALTER TABLE ONLY public.hr_events ALTER COLUMN id SET DEFAULT nextval('public.hr_events_id_seq'::regclass);

ALTER TABLE ONLY public.work_contracts ALTER COLUMN id SET DEFAULT nextval('public.work_contracts_id_seq'::regclass);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.employers
    ADD CONSTRAINT employers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hr_clock
    ADD CONSTRAINT hr_clock_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hr_documents
    ADD CONSTRAINT hr_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hr_events
    ADD CONSTRAINT hr_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_contracts
    ADD CONSTRAINT work_contracts_pkey PRIMARY KEY (id);

CREATE INDEX hr_clock_emp ON public.hr_clock USING btree (employee_id, at);

CREATE INDEX hr_documents_emp ON public.hr_documents USING btree (employee_id);

CREATE UNIQUE INDEX hr_employees_driver ON public.hr_employees USING btree (driver_code) WHERE (driver_code IS NOT NULL);

CREATE UNIQUE INDEX hr_employees_user ON public.hr_employees USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX hr_events_emp ON public.hr_events USING btree (employee_id, day_from);

CREATE INDEX work_contracts_created ON public.work_contracts USING btree (created_at DESC);

CREATE INDEX work_contracts_employee ON public.work_contracts USING btree (employee_id);

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER employers_touch BEFORE UPDATE ON public.employers FOR EACH ROW EXECUTE FUNCTION public.employers_touch();

CREATE TRIGGER hr_events_drive_reset BEFORE UPDATE ON public.hr_events FOR EACH ROW EXECUTE FUNCTION public.rh_drive_reset();

CREATE TRIGGER hr_touch BEFORE INSERT OR UPDATE ON public.hr_documents FOR EACH ROW EXECUTE FUNCTION public.hr_touch();

CREATE TRIGGER hr_touch BEFORE INSERT OR UPDATE ON public.hr_employees FOR EACH ROW EXECUTE FUNCTION public.hr_touch();

CREATE TRIGGER hr_touch BEFORE INSERT OR UPDATE ON public.hr_events FOR EACH ROW EXECUTE FUNCTION public.hr_touch();

CREATE TRIGGER hr_user_guard BEFORE INSERT OR UPDATE ON public.hr_employees FOR EACH ROW EXECUTE FUNCTION public.hr_user_guard();

CREATE TRIGGER work_contracts_drive_reset BEFORE UPDATE ON public.work_contracts FOR EACH ROW EXECUTE FUNCTION public.rh_drive_reset();

CREATE TRIGGER work_contracts_guard BEFORE INSERT OR UPDATE ON public.work_contracts FOR EACH ROW EXECUTE FUNCTION public.work_contracts_guard();
