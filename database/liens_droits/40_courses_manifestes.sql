-- =============================================================================
-- Courses privées, grilles tarifaires et manifestes (clés étrangères et droits : RLS, règles, GRANT)
-- Courses et devis (missions, validation par l'administrateur, double réservation refusée), grilles par ville de départ,
-- manifestes et sociétés émettrices (manifest_config).
-- Tables : manifest_config, manifests, missions, pricing_grid
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Clés étrangères

ALTER TABLE ONLY public.missions
    ADD CONSTRAINT missions_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------- Sécurité des lignes (RLS)

CREATE POLICY admin_all ON public.manifest_config TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_all ON public.pricing_grid TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_delete ON public.manifests FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_delete ON public.missions FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY keep_main ON public.pricing_grid AS RESTRICTIVE FOR DELETE TO authenticated USING ((id <> 1));

ALTER TABLE public.manifest_config ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.manifests ENABLE ROW LEVEL SECURITY;

CREATE POLICY mgr_insert ON public.manifests FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

CREATE POLICY mgr_insert ON public.missions FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND ((agency_id IS NULL) OR (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))) AND (validated_by IS NULL) AND (validated_at IS NULL))));

CREATE POLICY mgr_update ON public.missions FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND ((created_by = ( SELECT auth.uid() AS uid)) OR (agency_id IS NULL) OR (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND ((agency_id IS NULL) OR (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))))));

ALTER TABLE public.missions ENABLE ROW LEVEL SECURITY;

CREATE POLICY own_update ON public.manifests FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (created_by = ( SELECT auth.uid() AS uid))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (created_by = ( SELECT auth.uid() AS uid)) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

ALTER TABLE public.pricing_grid ENABLE ROW LEVEL SECURITY;

CREATE POLICY read_agency ON public.manifests FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.missions FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (created_by = ( SELECT auth.uid() AS uid)) OR (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id IS NULL))));

CREATE POLICY read_mgr ON public.manifest_config FOR SELECT TO authenticated USING ((( SELECT public.my_role() AS my_role) = ANY (ARRAY['admin'::text, 'manager'::text])));

CREATE POLICY read_mgr ON public.pricing_grid FOR SELECT TO authenticated USING ((( SELECT public.my_role() AS my_role) = ANY (ARRAY['admin'::text, 'manager'::text])));

-- ----------------------------------------------------------------------------- Droits et commentaires

GRANT ALL ON FUNCTION public.manifest_config_keep() TO anon;
GRANT ALL ON FUNCTION public.manifest_config_keep() TO authenticated;
GRANT ALL ON FUNCTION public.manifest_config_keep() TO service_role;

GRANT ALL ON FUNCTION public.mission_booking() TO anon;
GRANT ALL ON FUNCTION public.mission_booking() TO authenticated;
GRANT ALL ON FUNCTION public.mission_booking() TO service_role;

GRANT ALL ON FUNCTION public.mission_guard() TO anon;
GRANT ALL ON FUNCTION public.mission_guard() TO authenticated;
GRANT ALL ON FUNCTION public.mission_guard() TO service_role;

GRANT ALL ON FUNCTION public.mission_number() TO anon;
GRANT ALL ON FUNCTION public.mission_number() TO authenticated;
GRANT ALL ON FUNCTION public.mission_number() TO service_role;

REVOKE ALL ON FUNCTION public.mission_quick_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.mission_quick_guard() TO authenticated;
GRANT ALL ON FUNCTION public.mission_quick_guard() TO service_role;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.manifest_config TO authenticated;
GRANT ALL ON TABLE public.manifest_config TO service_role;

GRANT ALL ON SEQUENCE public.manifest_config_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.manifest_config_id_seq TO service_role;

GRANT SELECT,DELETE ON TABLE public.manifests TO authenticated;
GRANT ALL ON TABLE public.manifests TO service_role;

GRANT INSERT(vehicle_key) ON TABLE public.manifests TO authenticated;

GRANT INSERT(plate) ON TABLE public.manifests TO authenticated;

GRANT INSERT(driver_name) ON TABLE public.manifests TO authenticated;

GRANT INSERT(driver_phone) ON TABLE public.manifests TO authenticated;

GRANT INSERT(client) ON TABLE public.manifests TO authenticated;

GRANT INSERT(depart_at) ON TABLE public.manifests TO authenticated;

GRANT INSERT(file_name) ON TABLE public.manifests TO authenticated;

GRANT INSERT(file_path) ON TABLE public.manifests TO authenticated;

GRANT INSERT(message) ON TABLE public.manifests TO authenticated;

GRANT INSERT(data) ON TABLE public.manifests TO authenticated;

GRANT ALL ON SEQUENCE public.manifests_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.manifests_id_seq TO service_role;

GRANT ALL ON SEQUENCE public.mission_number_seq TO authenticated;
GRANT ALL ON SEQUENCE public.mission_number_seq TO service_role;

GRANT SELECT,DELETE ON TABLE public.missions TO authenticated;
GRANT ALL ON TABLE public.missions TO service_role;

GRANT INSERT(status),UPDATE(status) ON TABLE public.missions TO authenticated;

GRANT INSERT(agency_id),UPDATE(agency_id) ON TABLE public.missions TO authenticated;

GRANT INSERT(client_name),UPDATE(client_name) ON TABLE public.missions TO authenticated;

GRANT INSERT(client_company),UPDATE(client_company) ON TABLE public.missions TO authenticated;

GRANT INSERT(client_phone),UPDATE(client_phone) ON TABLE public.missions TO authenticated;

GRANT INSERT(client_email),UPDATE(client_email) ON TABLE public.missions TO authenticated;

GRANT INSERT(kind),UPDATE(kind) ON TABLE public.missions TO authenticated;

GRANT INSERT(category),UPDATE(category) ON TABLE public.missions TO authenticated;

GRANT INSERT(vehicle_key),UPDATE(vehicle_key) ON TABLE public.missions TO authenticated;

GRANT INSERT(driver_name),UPDATE(driver_name) ON TABLE public.missions TO authenticated;

GRANT INSERT(start_at),UPDATE(start_at) ON TABLE public.missions TO authenticated;

GRANT INSERT(end_at),UPDATE(end_at) ON TABLE public.missions TO authenticated;

GRANT INSERT(level),UPDATE(level) ON TABLE public.missions TO authenticated;

GRANT INSERT(needs_validation),UPDATE(needs_validation) ON TABLE public.missions TO authenticated;

GRANT UPDATE(validated_by) ON TABLE public.missions TO authenticated;

GRANT UPDATE(validated_at) ON TABLE public.missions TO authenticated;

GRANT INSERT(total_ttc),UPDATE(total_ttc) ON TABLE public.missions TO authenticated;

GRANT INSERT(deposit),UPDATE(deposit) ON TABLE public.missions TO authenticated;

GRANT INSERT(data),UPDATE(data) ON TABLE public.missions TO authenticated;

GRANT ALL ON SEQUENCE public.missions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.missions_id_seq TO service_role;

GRANT SELECT,DELETE ON TABLE public.pricing_grid TO authenticated;
GRANT ALL ON TABLE public.pricing_grid TO service_role;

GRANT INSERT(data),UPDATE(data) ON TABLE public.pricing_grid TO authenticated;

GRANT UPDATE(updated_at) ON TABLE public.pricing_grid TO authenticated;

GRANT UPDATE(updated_by) ON TABLE public.pricing_grid TO authenticated;

GRANT INSERT(name),UPDATE(name) ON TABLE public.pricing_grid TO authenticated;

GRANT INSERT(agency_id),UPDATE(agency_id) ON TABLE public.pricing_grid TO authenticated;

GRANT ALL ON SEQUENCE public.pricing_grid_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.pricing_grid_id_seq TO service_role;
