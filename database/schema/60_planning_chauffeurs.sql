-- =============================================================================
-- Planning des chauffeurs (structure)
-- Réglages par chauffeur (driver_roster), cases jour / nuit (driver_plan), absences, semaines publiées ou verrouillées, historique.
-- Tables : driver_absences, driver_plan, driver_roster, plan_log, plan_weeks
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.plan_absence_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r public.driver_absences;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  if coalesce(my_role(), '') = 'manager' and exists (select 1 from plan_weeks w where w.agency_id = r.agency_id and w.locked
       and w.week <= r.day_to and w.week + 6 >= r.day_from) then
    raise exception 'semaine verrouillée : absence à poser par l''administrateur';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

CREATE FUNCTION public.plan_log_trg() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare j jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
begin
  insert into plan_log (agency_id, action, detail) values ((j->>'agency_id')::bigint,
    case tg_table_name when 'driver_absences' then 'absence' else 'chauffeur' end || ' ' || lower(tg_op),
    case tg_table_name when 'driver_absences' then (j->>'driver_code') || ' du ' || (j->>'day_from') || ' au ' || (j->>'day_to') || coalesce(' · ' || (j->>'reason'), '')
      else (j->>'driver_code') || ' : shift ' || coalesce(j->>'shift', '—') || ', véhicule ' || coalesce(j->>'vehicle_key', '—') || ', repos ' || coalesce(nullif(translate(j->>'off_days', '[]', ''), ''), '—')
        || case when (j->>'active') = 'false' then ', inactif' else '' end end);
  return case when tg_op = 'DELETE' then old else new end;
end $$;

CREATE FUNCTION public.plan_replace_driver(p_agency bigint, p_old text, p_new text, p_from date, p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare w date; r driver_roster; n_moved integer := 0; n_free integer := 0;
begin
  if p_old is null or p_new is null or p_old = p_new then raise exception 'choisir le chauffeur qui part et son remplaçant'; end if;
  if not plan_can_edit(p_agency, null) then raise exception 'modification du planning non autorisée'; end if;
  if not plan_driver_in(p_old, p_agency) or not plan_driver_in(p_new, p_agency) then raise exception 'chauffeur d''une autre agence'; end if;
  for w in select distinct (day - (extract(isodow from day)::int - 1))::date from driver_plan where agency_id = p_agency and driver_code = p_old and day >= p_from loop
    if not plan_can_edit(p_agency, w) then raise exception 'semaine du % verrouillée : remplacement impossible', to_char(w, 'DD/MM/YYYY'); end if;
  end loop;
  -- cases de l'ancien : au remplaçant, sauf les jours où il travaille déjà (case à pourvoir)
  with free as (
    update driver_plan p set driver_code = null, locked = false, note = 'à pourvoir : ' || p_old || ' parti, remplaçant déjà en service ce jour', updated_at = now(), updated_by = auth.uid()
     where p.agency_id = p_agency and p.driver_code = p_old and p.day >= p_from
       and exists (select 1 from driver_plan x where x.agency_id = p_agency and x.day = p.day and x.driver_code = p_new)
    returning 1)
  select count(*) into n_free from free;
  with moved as (
    update driver_plan set driver_code = p_new, updated_at = now(), updated_by = auth.uid()
     where agency_id = p_agency and driver_code = p_old and day >= p_from returning 1)
  select count(*) into n_moved from moved;
  -- réglages repris par le remplaçant ; l'ancien devient ex-chauffeur
  select * into r from driver_roster where driver_code = p_old;
  insert into driver_roster (driver_code, agency_id, shift, vehicle_key, off_days, active, left_at, left_reason, replaced_by, updated_at, updated_by)
  values (p_new, p_agency, r.shift, r.vehicle_key, coalesce(r.off_days, '{}'), true, null, null, null, now(), auth.uid())
  on conflict (driver_code) do update set agency_id = p_agency, shift = coalesce(excluded.shift, driver_roster.shift), vehicle_key = coalesce(excluded.vehicle_key, driver_roster.vehicle_key),
    off_days = case when cardinality(excluded.off_days) = 2 then excluded.off_days else driver_roster.off_days end, active = true, left_at = null, left_reason = null, replaced_by = null,
    updated_at = now(), updated_by = auth.uid();
  insert into driver_roster (driver_code, agency_id, active, left_at, left_reason, replaced_by, updated_at, updated_by)
  values (p_old, p_agency, false, p_from, p_reason, p_new, now(), auth.uid())
  on conflict (driver_code) do update set active = false, left_at = p_from, left_reason = p_reason, replaced_by = p_new, updated_at = now(), updated_by = auth.uid();
  insert into plan_log (agency_id, action, detail) values (p_agency, 'départ', p_old || ' remplacé par ' || p_new || ' à partir du ' || to_char(p_from, 'DD/MM/YYYY')
    || ' : ' || n_moved || ' shift(s) repris' || case when n_free > 0 then ', ' || n_free || ' à pourvoir' else '' end || coalesce(' · ' || p_reason, ''));
  return jsonb_build_object('moved', n_moved, 'free', n_free);
end $$;

CREATE FUNCTION public.plan_save(p_agency bigint, p_from date, p_to date, p_cells jsonb, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare w date; n_changed integer; n_cells integer; bad text;
begin
  if p_to < p_from or p_to - p_from > 41 then raise exception 'période invalide'; end if;
  for w in select distinct (d - ((extract(isodow from d)::int - 1) * interval '1 day'))::date from generate_series(p_from, p_to, interval '1 day') d loop
    if not plan_can_edit(p_agency, w) then raise exception 'modification du planning non autorisée (droits ou semaine verrouillée)'; end if;
  end loop;
  create temp table _n on commit drop as
    select (c->>'day')::date as day, c->>'shift' as shift, c->>'vehicle_key' as vehicle_key, nullif(c->>'driver_code', '') as driver_code,
           coalesce((c->>'locked')::boolean, false) as locked, nullif(c->>'note', '') as note
      from jsonb_array_elements(coalesce(p_cells, '[]')) c where (c->>'day')::date between p_from and p_to;
  -- cases d'une autre agence (même véhicule, même jour) jamais reprises ; gestionnaire : véhicules de l'agence seulement
  select n.vehicle_key into bad from _n n join driver_plan o using (day, shift, vehicle_key) where o.agency_id is distinct from p_agency limit 1;
  if bad is not null then raise exception 'véhicule % planifié dans une autre agence ce jour-là', bad; end if;
  if not is_admin() then
    select n.vehicle_key into bad from _n n left join vehicles v on v.key = n.vehicle_key where v.agency_id is distinct from p_agency limit 1;
    if bad is not null then raise exception 'véhicule % hors de l''agence', bad; end if;
  end if;
  select count(*) into n_cells from _n;
  select count(*) into n_changed from _n full join (select * from driver_plan where agency_id = p_agency and day between p_from and p_to) o
    using (day, shift, vehicle_key) where _n.driver_code is distinct from o.driver_code;
  delete from driver_plan where agency_id = p_agency and day between p_from and p_to;
  insert into driver_plan (agency_id, day, shift, vehicle_key, driver_code, locked, note, updated_at, updated_by)
  select p_agency, day, shift, vehicle_key, driver_code, locked, note, now(), auth.uid() from _n;
  if n_changed > 0 then insert into plan_log (agency_id, action, detail) values (p_agency, 'modification', p_from || ' → ' || p_to || ' : ' || n_changed || ' case(s) changée(s)' || coalesce(' · ' || p_note, '')); end if;
  return jsonb_build_object('cells', n_cells, 'changed', n_changed);
end $$;

CREATE FUNCTION public.plan_week_set(p_agency bigint, p_week date, p_action text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_action = 'publier' then
    if not plan_can_edit(p_agency, p_week) then raise exception 'publication non autorisée'; end if;
    insert into plan_weeks (agency_id, week, published_at, published_by) values (p_agency, p_week, now(), auth.uid())
    on conflict (agency_id, week) do update set published_at = now(), published_by = auth.uid();
  elsif p_action in ('verrouiller', 'déverrouiller') then
    if not is_admin() then raise exception 'verrouillage réservé à l''administrateur'; end if;
    insert into plan_weeks (agency_id, week, locked, locked_by, locked_at) values (p_agency, p_week, p_action = 'verrouiller', auth.uid(), now())
    on conflict (agency_id, week) do update set locked = (p_action = 'verrouiller'), locked_by = auth.uid(), locked_at = now();
  else raise exception 'action inconnue'; end if;
  insert into plan_log (agency_id, action, detail) values (p_agency, p_action, 'semaine du ' || to_char(p_week, 'DD/MM/YYYY'));
  return (select to_jsonb(w) from plan_weeks w where agency_id = p_agency and week = p_week);
end $$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.driver_absences (
    id bigint NOT NULL,
    agency_id bigint,
    driver_code text NOT NULL,
    day_from date NOT NULL,
    day_to date NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid DEFAULT auth.uid(),
    CONSTRAINT driver_absences_check CHECK ((day_to >= day_from))
);

CREATE SEQUENCE public.driver_absences_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.driver_absences_id_seq OWNED BY public.driver_absences.id;

CREATE TABLE public.driver_plan (
    id bigint NOT NULL,
    agency_id bigint,
    day date NOT NULL,
    shift text NOT NULL,
    vehicle_key text NOT NULL,
    driver_code text,
    locked boolean DEFAULT false NOT NULL,
    note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid DEFAULT auth.uid(),
    CONSTRAINT driver_plan_shift_check CHECK ((shift = ANY (ARRAY['Jour'::text, 'Nuit'::text])))
);

CREATE SEQUENCE public.driver_plan_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.driver_plan_id_seq OWNED BY public.driver_plan.id;

CREATE TABLE public.driver_roster (
    driver_code text NOT NULL,
    agency_id bigint,
    shift text,
    vehicle_key text,
    off_days smallint[] DEFAULT '{}'::smallint[] NOT NULL,
    active boolean DEFAULT true NOT NULL,
    note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid DEFAULT auth.uid(),
    left_at date,
    left_reason text,
    replaced_by text,
    CONSTRAINT driver_roster_shift_check CHECK ((shift = ANY (ARRAY['Jour'::text, 'Nuit'::text])))
);

CREATE TABLE public.plan_log (
    id bigint NOT NULL,
    agency_id bigint,
    at timestamp with time zone DEFAULT now() NOT NULL,
    by uuid DEFAULT auth.uid(),
    action text,
    detail text
);

CREATE SEQUENCE public.plan_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.plan_log_id_seq OWNED BY public.plan_log.id;

CREATE TABLE public.plan_weeks (
    agency_id bigint NOT NULL,
    week date NOT NULL,
    published_at timestamp with time zone,
    published_by uuid,
    locked boolean DEFAULT false NOT NULL,
    locked_by uuid,
    locked_at timestamp with time zone
);

ALTER TABLE ONLY public.driver_absences ALTER COLUMN id SET DEFAULT nextval('public.driver_absences_id_seq'::regclass);

ALTER TABLE ONLY public.driver_plan ALTER COLUMN id SET DEFAULT nextval('public.driver_plan_id_seq'::regclass);

ALTER TABLE ONLY public.plan_log ALTER COLUMN id SET DEFAULT nextval('public.plan_log_id_seq'::regclass);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.driver_absences
    ADD CONSTRAINT driver_absences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.driver_plan
    ADD CONSTRAINT driver_plan_day_shift_vehicle_key_key UNIQUE (day, shift, vehicle_key);

ALTER TABLE ONLY public.driver_plan
    ADD CONSTRAINT driver_plan_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.driver_roster
    ADD CONSTRAINT driver_roster_pkey PRIMARY KEY (driver_code);

ALTER TABLE ONLY public.plan_log
    ADD CONSTRAINT plan_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.plan_weeks
    ADD CONSTRAINT plan_weeks_pkey PRIMARY KEY (agency_id, week);

CREATE INDEX driver_absences_days ON public.driver_absences USING btree (agency_id, day_from, day_to);

CREATE INDEX driver_absences_driver ON public.driver_absences USING btree (driver_code);

CREATE INDEX driver_plan_agency ON public.driver_plan USING btree (agency_id, day);

CREATE INDEX driver_plan_driver ON public.driver_plan USING btree (driver_code, day) WHERE (driver_code IS NOT NULL);

CREATE INDEX plan_log_agency ON public.plan_log USING btree (agency_id, at);

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER driver_absences_lock BEFORE INSERT OR DELETE OR UPDATE ON public.driver_absences FOR EACH ROW EXECUTE FUNCTION public.plan_absence_guard();

CREATE TRIGGER driver_absences_log AFTER INSERT OR DELETE OR UPDATE ON public.driver_absences FOR EACH ROW EXECUTE FUNCTION public.plan_log_trg();

CREATE TRIGGER driver_roster_log AFTER INSERT OR DELETE OR UPDATE ON public.driver_roster FOR EACH ROW EXECUTE FUNCTION public.plan_log_trg();
