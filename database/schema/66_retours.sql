-- =============================================================================
-- Retours des véhicules à l'agence (structure)
-- Appels de retour : heure de retour donnée à chaque chauffeur, message WhatsApp envoyé, arrivée à l'agence vue par le GPS,
-- retour fait (page Retours véhicules) ; position GPS de chaque agence dans agencies (lat, lng, rayon d'arrivée).
-- Tables : return_calls
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Fonctions

CREATE FUNCTION public.return_calls_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
    if new.agency_id is null then new.agency_id := (select agency_id from vehicles where key = new.vehicle_key); end if;
  else
    new.created_at := old.created_at; new.created_by := old.created_by; new.contract_num := old.contract_num; new.vehicle_key := old.vehicle_key;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------- Tables

CREATE TABLE public.return_calls (
    id bigint NOT NULL,
    agency_id bigint,
    contract_num text NOT NULL,
    vehicle_key text NOT NULL,
    driver_name text,
    phone text,
    rank integer,
    slot_at timestamp with time zone,
    sent_at timestamp with time zone,
    sent_by text,
    dist_at_send_m integer,
    arrived_at timestamp with time zone,
    done_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid DEFAULT auth.uid(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.return_calls_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.return_calls_id_seq OWNED BY public.return_calls.id;

ALTER TABLE ONLY public.return_calls ALTER COLUMN id SET DEFAULT nextval('public.return_calls_id_seq'::regclass);

-- ----------------------------------------------------------------------------- Clés et index

ALTER TABLE ONLY public.return_calls
    ADD CONSTRAINT return_calls_pkey PRIMARY KEY (id);

CREATE INDEX return_calls_arrived ON public.return_calls USING btree (arrived_at) WHERE ((done_at IS NULL) AND (cancelled_at IS NULL));

CREATE INDEX return_calls_created ON public.return_calls USING btree (created_at);

CREATE UNIQUE INDEX return_calls_open ON public.return_calls USING btree (contract_num) WHERE ((done_at IS NULL) AND (cancelled_at IS NULL));

CREATE INDEX return_calls_veh ON public.return_calls USING btree (vehicle_key, created_at);

-- ----------------------------------------------------------------------------- Déclencheurs

CREATE TRIGGER return_calls_guard BEFORE INSERT OR UPDATE ON public.return_calls FOR EACH ROW EXECUTE FUNCTION public.return_calls_guard();
