-- =============================================================================
-- Retours des véhicules à l'agence (clés étrangères et droits : RLS, règles, GRANT)
-- Appels de retour : heure de retour donnée à chaque chauffeur, message WhatsApp envoyé, arrivée à l'agence vue par le GPS,
-- retour fait (page Retours véhicules) ; position GPS de chaque agence dans agencies (lat, lng, rayon d'arrivée).
-- Tables : return_calls
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Clés étrangères

ALTER TABLE ONLY public.return_calls
    ADD CONSTRAINT return_calls_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------- Sécurité des lignes (RLS)

CREATE POLICY rc_del ON public.return_calls FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY rc_ins ON public.return_calls FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

CREATE POLICY rc_read ON public.return_calls FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY rc_upd ON public.return_calls FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

ALTER TABLE public.return_calls ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------- Droits et commentaires

GRANT ALL ON FUNCTION public.return_calls_guard() TO authenticated;
GRANT ALL ON FUNCTION public.return_calls_guard() TO service_role;

GRANT ALL ON TABLE public.return_calls TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.return_calls TO authenticated;

GRANT ALL ON SEQUENCE public.return_calls_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.return_calls_id_seq TO service_role;
