-- =============================================================================
-- Socle : fonctions de droits, paramètres, demandes du site, journal technique, versions du collecteur, suivi des limites (clés étrangères et droits : RLS, règles, GRANT)
-- Fonctions de droits (is_admin, my_role, my_vehicle_keys, rh_scope, plan_can_edit…), paramètres (params), règles de score (rules), demandes du site au collecteur (jobs), journal technique (logs),
-- versions du collecteur (releases), compteurs d'usage (usage_daily), session Geotab du relais, coffre des intégrations.
-- Tables : geotab_session, integration_secrets, jobs, logs, params, releases, rules, usage_daily
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Sécurité des lignes (RLS)

CREATE POLICY admin_update ON public.params FOR UPDATE TO authenticated USING ((( SELECT public.my_role() AS my_role) = 'admin'::text)) WITH CHECK ((( SELECT public.my_role() AS my_role) = 'admin'::text));

CREATE POLICY admin_update ON public.rules FOR UPDATE TO authenticated USING ((( SELECT public.my_role() AS my_role) = 'admin'::text)) WITH CHECK ((( SELECT public.my_role() AS my_role) = 'admin'::text));

ALTER TABLE public.geotab_session ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.integration_secrets ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY mgr_insert ON public.jobs FOR INSERT TO authenticated WITH CHECK (((created_by = ( SELECT auth.uid() AS uid)) AND (( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND ((kind = ANY (ARRAY['sync_now'::text, 'recompute'::text, 'after_inject'::text, 'apply_plates'::text])) OR ((kind = 'driver_report'::text) AND
CASE
    WHEN (COALESCE(arg, ''::text) ~ '^\s*\{'::text) THEN (((arg)::jsonb ->> 'code'::text) = ANY (( SELECT public.my_driver_codes() AS my_driver_codes)::text[]))
    ELSE false
END) OR ((kind = 'manifest_mail'::text) AND
CASE
    WHEN (COALESCE(arg, ''::text) ~ '^\s*\{"id":\s*\d{1,18}\s*[,}]'::text) THEN (EXISTS ( SELECT 1
       FROM public.manifests m
      WHERE ((m.id = (((jobs.arg)::jsonb ->> 'id'::text))::bigint) AND (m.vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))))
    ELSE false
END) OR ((kind = 'quote_mail'::text) AND
CASE
    WHEN (COALESCE(arg, ''::text) ~ '^\s*\{"id":\s*\d{1,18}\s*[,}]'::text) THEN (EXISTS ( SELECT 1
       FROM public.missions x
      WHERE ((x.id = (((jobs.arg)::jsonb ->> 'id'::text))::bigint) AND ((x.created_by = ( SELECT auth.uid() AS uid)) OR (x.agency_id IS NULL) OR (x.agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))))))
    ELSE false
END))))));

ALTER TABLE public.params ENABLE ROW LEVEL SECURITY;

CREATE POLICY read_admin ON public.logs FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY read_admin ON public.releases FOR SELECT TO authenticated USING ((( SELECT public.my_role() AS my_role) = 'admin'::text));

CREATE POLICY read_all ON public.params FOR SELECT TO authenticated USING ((( SELECT public.my_role() AS my_role) = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])));

CREATE POLICY read_all ON public.rules FOR SELECT TO authenticated USING ((( SELECT public.my_role() AS my_role) = ANY (ARRAY['admin'::text, 'manager'::text, 'viewer'::text])));

CREATE POLICY read_mgr ON public.jobs FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (created_by = ( SELECT auth.uid() AS uid)))));

ALTER TABLE public.releases ENABLE ROW LEVEL SECURITY;

CREATE POLICY rh_read ON public.params FOR SELECT TO authenticated USING (( SELECT public.is_rh() AS is_rh));

ALTER TABLE public.rules ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.usage_daily ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------- Droits et commentaires

COMMENT ON SCHEMA public IS 'standard public schema';

GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;

REVOKE ALL ON FUNCTION public.bump_usage(p_kind text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bump_usage(p_kind text) TO service_role;

GRANT ALL ON FUNCTION public.cash_folder_ok(f text) TO anon;
GRANT ALL ON FUNCTION public.cash_folder_ok(f text) TO authenticated;
GRANT ALL ON FUNCTION public.cash_folder_ok(f text) TO service_role;

REVOKE ALL ON FUNCTION public.db_size() FROM PUBLIC;
GRANT ALL ON FUNCTION public.db_size() TO service_role;

REVOKE ALL ON FUNCTION public.hr_can(p_kind text, p_agency bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hr_can(p_kind text, p_agency bigint) TO authenticated;
GRANT ALL ON FUNCTION public.hr_can(p_kind text, p_agency bigint) TO service_role;

REVOKE ALL ON FUNCTION public.hr_can_emp(p_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hr_can_emp(p_id bigint) TO authenticated;
GRANT ALL ON FUNCTION public.hr_can_emp(p_id bigint) TO service_role;

REVOKE ALL ON FUNCTION public.integration_set(p_name text, p_value text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.integration_set(p_name text, p_value text) TO authenticated;
GRANT ALL ON FUNCTION public.integration_set(p_name text, p_value text) TO service_role;

REVOKE ALL ON FUNCTION public.integration_status() FROM PUBLIC;
GRANT ALL ON FUNCTION public.integration_status() TO authenticated;
GRANT ALL ON FUNCTION public.integration_status() TO service_role;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_admin() TO service_role;

REVOKE ALL ON FUNCTION public.is_rh() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_rh() TO authenticated;
GRANT ALL ON FUNCTION public.is_rh() TO service_role;

REVOKE ALL ON FUNCTION public.my_agency_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.my_agency_ids() TO authenticated;
GRANT ALL ON FUNCTION public.my_agency_ids() TO service_role;

REVOKE ALL ON FUNCTION public.my_driver_codes() FROM PUBLIC;
GRANT ALL ON FUNCTION public.my_driver_codes() TO authenticated;
GRANT ALL ON FUNCTION public.my_driver_codes() TO service_role;

REVOKE ALL ON FUNCTION public.my_role() FROM PUBLIC;
GRANT ALL ON FUNCTION public.my_role() TO authenticated;
GRANT ALL ON FUNCTION public.my_role() TO service_role;

REVOKE ALL ON FUNCTION public.my_vehicle_keys() FROM PUBLIC;
GRANT ALL ON FUNCTION public.my_vehicle_keys() TO authenticated;
GRANT ALL ON FUNCTION public.my_vehicle_keys() TO service_role;

GRANT ALL ON FUNCTION public.name_key(t text) TO anon;
GRANT ALL ON FUNCTION public.name_key(t text) TO authenticated;
GRANT ALL ON FUNCTION public.name_key(t text) TO service_role;

GRANT ALL ON FUNCTION public.norm_name(t text) TO anon;
GRANT ALL ON FUNCTION public.norm_name(t text) TO authenticated;
GRANT ALL ON FUNCTION public.norm_name(t text) TO service_role;

GRANT ALL ON FUNCTION public.norm_plate(s text) TO anon;
GRANT ALL ON FUNCTION public.norm_plate(s text) TO authenticated;
GRANT ALL ON FUNCTION public.norm_plate(s text) TO service_role;

REVOKE ALL ON FUNCTION public.plan_can_edit(p_agency bigint, p_week date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.plan_can_edit(p_agency bigint, p_week date) TO authenticated;
GRANT ALL ON FUNCTION public.plan_can_edit(p_agency bigint, p_week date) TO service_role;

REVOKE ALL ON FUNCTION public.plan_can_read(p_agency bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.plan_can_read(p_agency bigint) TO authenticated;
GRANT ALL ON FUNCTION public.plan_can_read(p_agency bigint) TO service_role;

REVOKE ALL ON FUNCTION public.plan_driver_in(p_code text, p_agency bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.plan_driver_in(p_code text, p_agency bigint) TO authenticated;
GRANT ALL ON FUNCTION public.plan_driver_in(p_code text, p_agency bigint) TO service_role;

REVOKE ALL ON FUNCTION public.rh_agency_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.rh_agency_ids() TO authenticated;
GRANT ALL ON FUNCTION public.rh_agency_ids() TO service_role;

REVOKE ALL ON FUNCTION public.rh_driver_codes() FROM PUBLIC;
GRANT ALL ON FUNCTION public.rh_driver_codes() TO authenticated;
GRANT ALL ON FUNCTION public.rh_driver_codes() TO service_role;

REVOKE ALL ON FUNCTION public.rh_scope(p_agency bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rh_scope(p_agency bigint) TO authenticated;
GRANT ALL ON FUNCTION public.rh_scope(p_agency bigint) TO service_role;

REVOKE ALL ON FUNCTION public.rh_staff_users() FROM PUBLIC;
GRANT ALL ON FUNCTION public.rh_staff_users() TO authenticated;
GRANT ALL ON FUNCTION public.rh_staff_users() TO service_role;

REVOKE ALL ON FUNCTION public.usage_stats() FROM PUBLIC;
GRANT ALL ON FUNCTION public.usage_stats() TO authenticated;
GRANT ALL ON FUNCTION public.usage_stats() TO service_role;

REVOKE ALL ON FUNCTION public.wc_can(p_agency bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.wc_can(p_agency bigint) TO authenticated;
GRANT ALL ON FUNCTION public.wc_can(p_agency bigint) TO service_role;

GRANT ALL ON TABLE public.geotab_session TO service_role;

GRANT ALL ON TABLE public.integration_secrets TO service_role;

GRANT SELECT ON TABLE public.jobs TO authenticated;
GRANT ALL ON TABLE public.jobs TO service_role;

GRANT INSERT(kind) ON TABLE public.jobs TO authenticated;

GRANT INSERT(arg) ON TABLE public.jobs TO authenticated;

GRANT ALL ON SEQUENCE public.jobs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.jobs_id_seq TO service_role;

GRANT SELECT ON TABLE public.logs TO authenticated;
GRANT ALL ON TABLE public.logs TO service_role;

GRANT ALL ON SEQUENCE public.logs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.logs_id_seq TO service_role;

GRANT SELECT ON TABLE public.params TO authenticated;
GRANT ALL ON TABLE public.params TO service_role;

GRANT UPDATE(value) ON TABLE public.params TO authenticated;

GRANT ALL ON TABLE public.releases TO service_role;

GRANT SELECT(id) ON TABLE public.releases TO authenticated;

GRANT SELECT(version) ON TABLE public.releases TO authenticated;

GRANT SELECT(sha) ON TABLE public.releases TO authenticated;

GRANT SELECT(created_at) ON TABLE public.releases TO authenticated;

GRANT ALL ON SEQUENCE public.releases_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.releases_id_seq TO service_role;

GRANT SELECT ON TABLE public.rules TO authenticated;
GRANT ALL ON TABLE public.rules TO service_role;

GRANT UPDATE(weight) ON TABLE public.rules TO authenticated;

GRANT ALL ON TABLE public.usage_daily TO service_role;

-- ----------------------------------------------------------------------------- Droits par défaut

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;

--
-- PostgreSQL database dump complete
--
