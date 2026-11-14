-- =============================================================================
-- Pauses chauffeurs et suivi des courses privées (structure)
-- Pauses déclenchées par le gestionnaire (2 h par chauffeur et par shift, véhicule qui bouge pendant la pause noté),
-- suivi d'une course privée de la prise en charge à l'arrivée (positions GPS Geotab relevées),
-- téléphones Android qui reçoivent les alertes écran éteint (secret par téléphone, watch_poll).
-- Tables : driver_pauses, mission_tracks, watch_devices
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

CREATE FUNCTION public.watch_poll(p_secret text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare d watch_devices; v_role text; v_ag bigint[]; v_keys text[]; v_admin boolean;
begin
  select * into d from watch_devices where secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex');
  if d.id is null then raise exception 'watch_unknown' using errcode = '28000'; end if;
  v_role := coalesce((select role from profiles where user_id = d.user_id), '');
  if v_role not in ('admin', 'manager', 'viewer') then raise exception 'watch_unknown' using errcode = '28000'; end if;
  v_admin := v_role = 'admin';
  v_ag := coalesce((select array_agg(agency_id) from user_agencies where user_id = d.user_id), '{}');
  v_keys := coalesce((select array_agg(key) from vehicles where agency_id = any(v_ag)), '{}');
  if d.last_seen is null or d.last_seen < now() - interval '1 minute' then update watch_devices set last_seen = now() where id = d.id; end if;
  return jsonb_build_object(
    'now', now(),
    'user_id', d.user_id,
    'params', coalesce((select jsonb_object_agg(key, value) from params where key in ('pauseShiftMin', 'pauseRemindMin', 'pauseMoveM', 'trackArriveM')), '{}'),
    'pauses', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'vehicle_key', p.vehicle_key, 'plate', p.plate, 'driver_name', p.driver_name,
        'driver_phone', p.driver_phone, 'started_at', p.started_at, 'planned_min', p.planned_min, 'start_lat', p.start_lat, 'start_lon', p.start_lon,
        'moved_at', p.moved_at, 'moved_m', p.moved_m, 'moved_note', p.moved_note) order by p.started_at)
      from driver_pauses p where p.ended_at is null and p.started_at > now() - interval '24 hours'
        and (v_admin or p.vehicle_key = any(v_keys) or p.agency_id = any(v_ag))), '[]'),
    'tracks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'mission_id', t.mission_id, 'vehicle_key', t.vehicle_key, 'plate', t.plate,
        'driver_name', t.driver_name, 'started_at', t.started_at, 'dest_label', t.dest_label, 'dest_lat', t.dest_lat, 'dest_lon', t.dest_lon,
        'arrived_at', t.arrived_at) order by t.started_at)
      from mission_tracks t where t.ended_at is null and t.started_at > now() - interval '48 hours'
        and (v_admin or t.vehicle_key = any(v_keys) or t.agency_id = any(v_ag))), '[]'));
end $$;

CREATE FUNCTION public.watch_register(p_label text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid := auth.uid(); v_secret text;
begin
  if v_uid is null or coalesce((select role from profiles where user_id = v_uid), '') not in ('admin', 'manager', 'viewer') then
    raise exception 'Compte non autorisé' using errcode = '42501';
  end if;
  v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into watch_devices (user_id, secret_hash, label) values (v_uid, encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'), left(coalesce(p_label, ''), 80));
  delete from watch_devices where user_id = v_uid and id not in (select id from watch_devices where user_id = v_uid order by id desc limit 5);
  return v_secret;
end $$;

CREATE FUNCTION public.watch_unregister(p_secret text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  delete from watch_devices where secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex')
$$;

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

CREATE TABLE public.watch_devices (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    secret_hash text NOT NULL,
    label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone
);

CREATE SEQUENCE public.watch_devices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.watch_devices_id_seq OWNED BY public.watch_devices.id;

ALTER TABLE ONLY public.watch_devices ALTER COLUMN id SET DEFAULT nextval('public.watch_devices_id_seq'::regclass);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.driver_pauses
    ADD CONSTRAINT driver_pauses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mission_tracks
    ADD CONSTRAINT mission_tracks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.watch_devices
    ADD CONSTRAINT watch_devices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.watch_devices
    ADD CONSTRAINT watch_devices_secret_hash_key UNIQUE (secret_hash);

CREATE INDEX driver_pauses_agency ON public.driver_pauses USING btree (agency_id, started_at DESC);

CREATE INDEX driver_pauses_driver ON public.driver_pauses USING btree (driver_code, shift_day);

CREATE UNIQUE INDEX driver_pauses_one_open ON public.driver_pauses USING btree (vehicle_key) WHERE (ended_at IS NULL);

CREATE INDEX driver_pauses_shift ON public.driver_pauses USING btree (shift_day, shift);

CREATE INDEX mission_tracks_mission ON public.mission_tracks USING btree (mission_id);

CREATE UNIQUE INDEX mission_tracks_one_open ON public.mission_tracks USING btree (mission_id) WHERE (ended_at IS NULL);

CREATE INDEX mission_tracks_started ON public.mission_tracks USING btree (agency_id, started_at DESC);

CREATE INDEX watch_devices_user ON public.watch_devices USING btree (user_id);

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER driver_pauses_guard BEFORE INSERT OR UPDATE ON public.driver_pauses FOR EACH ROW EXECUTE FUNCTION public.suivi_guard();

CREATE TRIGGER mission_tracks_guard BEFORE INSERT OR UPDATE ON public.mission_tracks FOR EACH ROW EXECUTE FUNCTION public.suivi_guard();
