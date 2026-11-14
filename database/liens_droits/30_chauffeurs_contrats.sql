-- =============================================================================
-- Chauffeurs et contrats de location (clés étrangères et droits : RLS, règles, GRANT)
-- Contrats injectés depuis l'extract (import_contracts) et chauffeurs qui en sont déduits (refresh_drivers).
-- Tables : contracts, drivers
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Clés étrangères

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------- Sécurité des lignes (RLS)

ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY mgr_delete ON public.drivers FOR DELETE TO authenticated USING (((source = 'manuel'::text) AND (( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))))));

CREATE POLICY mgr_insert ON public.drivers FOR INSERT TO authenticated WITH CHECK (((source = 'manuel'::text) AND (( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))))));

CREATE POLICY mgr_update ON public.drivers FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND ((agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])) OR ((agency_id IS NULL) AND (code = ANY (( SELECT public.my_driver_codes() AS my_driver_codes)::text[]))))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id IS NULL) AND (code = ANY (( SELECT public.my_driver_codes() AS my_driver_codes)::text[])))));

CREATE POLICY read_agency ON public.contracts FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.drivers FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (code = ANY (( SELECT public.my_driver_codes() AS my_driver_codes)::text[]))));

CREATE POLICY rh_read ON public.contracts FOR SELECT TO authenticated USING ((( SELECT public.is_rh() AS is_rh) AND (client_code = ANY (( SELECT public.rh_driver_codes() AS rh_driver_codes)::text[]))));

CREATE POLICY rh_read ON public.drivers FOR SELECT TO authenticated USING ((( SELECT public.is_rh() AS is_rh) AND public.rh_scope(agency_id)));

-- ----------------------------------------------------------------------------- Droits et commentaires

REVOKE ALL ON FUNCTION public.contract_first() FROM PUBLIC;
GRANT ALL ON FUNCTION public.contract_first() TO service_role;

GRANT ALL ON FUNCTION public.drivers_guard_trg() TO anon;
GRANT ALL ON FUNCTION public.drivers_guard_trg() TO authenticated;
GRANT ALL ON FUNCTION public.drivers_guard_trg() TO service_role;

REVOKE ALL ON FUNCTION public.import_contracts(p_rows jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.import_contracts(p_rows jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.import_contracts(p_rows jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.refresh_drivers() FROM PUBLIC;
GRANT ALL ON FUNCTION public.refresh_drivers() TO service_role;

GRANT SELECT ON TABLE public.contracts TO authenticated;
GRANT ALL ON TABLE public.contracts TO service_role;

GRANT SELECT,DELETE ON TABLE public.drivers TO authenticated;
GRANT ALL ON TABLE public.drivers TO service_role;

GRANT INSERT(code) ON TABLE public.drivers TO authenticated;

GRANT INSERT(name),UPDATE(name) ON TABLE public.drivers TO authenticated;

GRANT INSERT(phone),UPDATE(phone) ON TABLE public.drivers TO authenticated;

GRANT INSERT(email),UPDATE(email) ON TABLE public.drivers TO authenticated;

GRANT INSERT(status),UPDATE(status) ON TABLE public.drivers TO authenticated;

GRANT INSERT(detected_at) ON TABLE public.drivers TO authenticated;

GRANT INSERT(note),UPDATE(note) ON TABLE public.drivers TO authenticated;

GRANT INSERT(agency_id),UPDATE(agency_id) ON TABLE public.drivers TO authenticated;

GRANT INSERT(source) ON TABLE public.drivers TO authenticated;

GRANT UPDATE(uber_uuid) ON TABLE public.drivers TO authenticated;
