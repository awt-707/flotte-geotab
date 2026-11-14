-- =============================================================================
-- Pauses chauffeurs et suivi des courses privées (structure)
-- Pauses déclenchées par le gestionnaire (2 h par chauffeur et par shift, véhicule qui bouge pendant la pause noté),
-- suivi d'une course privée de la prise en charge à l'arrivée (positions GPS Geotab relevées).
-- Tables : driver_pauses, mission_tracks
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.suivi_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then new.started_at := now(); new.created_by := auth.uid(); end if;
    if new.ended_at is not null and (tg_op = 'INSERT' or old.ended_at is null) then
      new.ended_at := least(greatest(new.ended_at, new.started_at), now()); new.ended_by := auth.uid();
    end if;
    if tg_op = 'UPDATE' and old.ended_at is not null and new.ended_at is distinct from old.ended_at then
      raise exception 'suivi déjà terminé';
    end if;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.driver_pauses (
    id bigint NOT NULL,
    agency_id bigint,
    vehicle_key text NOT NULL,
    plate text,
    driver_code text,
    driver_name text,
    driver_phone text,
    contract_num text,
    shift_day date NOT NULL,
    shift text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    planned_min integer NOT NULL,
    ended_at timestamp with time zone,
    end_reason text,
    start_lat double precision,
    start_lon double precision,
    moved_at timestamp with time zone,
    moved_m integer,
    moved_note text,
    note text,
    created_by uuid DEFAULT auth.uid(),
    ended_by uuid,
    CONSTRAINT driver_pauses_planned_min_check CHECK (((planned_min >= 1) AND (planned_min <= 480))),
    CONSTRAINT driver_pauses_shift_check CHECK ((shift = ANY (ARRAY['Jour'::text, 'Nuit'::text])))
);

ALTER TABLE public.driver_pauses ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.driver_pauses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.mission_tracks (
    id bigint NOT NULL,
    mission_id bigint NOT NULL,
    agency_id bigint,
    vehicle_key text NOT NULL,
    plate text,
    driver_name text,
    driver_phone text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    dest_label text,
    dest_lat double precision,
    dest_lon double precision,
    arrived_at timestamp with time zone,
    ended_at timestamp with time zone,
    end_reason text,
    points jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by uuid DEFAULT auth.uid(),
    ended_by uuid
);

ALTER TABLE public.mission_tracks ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.mission_tracks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.driver_pauses
    ADD CONSTRAINT driver_pauses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mission_tracks
    ADD CONSTRAINT mission_tracks_pkey PRIMARY KEY (id);

CREATE INDEX driver_pauses_agency ON public.driver_pauses USING btree (agency_id, started_at DESC);

CREATE INDEX driver_pauses_driver ON public.driver_pauses USING btree (driver_code, shift_day);

CREATE UNIQUE INDEX driver_pauses_one_open ON public.driver_pauses USING btree (vehicle_key) WHERE (ended_at IS NULL);

CREATE INDEX driver_pauses_shift ON public.driver_pauses USING btree (shift_day, shift);

CREATE INDEX mission_tracks_mission ON public.mission_tracks USING btree (mission_id);

CREATE UNIQUE INDEX mission_tracks_one_open ON public.mission_tracks USING btree (mission_id) WHERE (ended_at IS NULL);

CREATE INDEX mission_tracks_started ON public.mission_tracks USING btree (agency_id, started_at DESC);

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER driver_pauses_guard BEFORE INSERT OR UPDATE ON public.driver_pauses FOR EACH ROW EXECUTE FUNCTION public.suivi_guard();

CREATE TRIGGER mission_tracks_guard BEFORE INSERT OR UPDATE ON public.mission_tracks FOR EACH ROW EXECUTE FUNCTION public.suivi_guard();
