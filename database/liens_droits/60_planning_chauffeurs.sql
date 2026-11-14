-- =============================================================================
-- Planning des chauffeurs (clés étrangères et droits : RLS, règles, GRANT)
-- Réglages par chauffeur (driver_roster), cases jour / nuit (driver_plan), absences, semaines publiées ou verrouillées, historique.
-- Tables : driver_absences, driver_plan, driver_roster, plan_log, plan_weeks
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Clés étrangères

ALTER TABLE ONLY public.driver_absences
    ADD CONSTRAINT driver_absences_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_plan
    ADD CONSTRAINT driver_plan_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.driver_roster
    ADD CONSTRAINT driver_roster_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.plan_weeks
    ADD CONSTRAINT plan_weeks_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------- Sécurité des lignes (RLS)

ALTER TABLE public.driver_absences ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.driver_plan ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.driver_roster ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.plan_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_read ON public.driver_absences FOR SELECT TO authenticated USING (( SELECT public.plan_can_read(driver_absences.agency_id) AS plan_can_read));

CREATE POLICY plan_read ON public.driver_plan FOR SELECT TO authenticated USING (( SELECT public.plan_can_read(driver_plan.agency_id) AS plan_can_read));

CREATE POLICY plan_read ON public.driver_roster FOR SELECT TO authenticated USING (( SELECT public.plan_can_read(driver_roster.agency_id) AS plan_can_read));

CREATE POLICY plan_read ON public.plan_log FOR SELECT TO authenticated USING (( SELECT public.plan_can_read(plan_log.agency_id) AS plan_can_read));

CREATE POLICY plan_read ON public.plan_weeks FOR SELECT TO authenticated USING (( SELECT public.plan_can_read(plan_weeks.agency_id) AS plan_can_read));

ALTER TABLE public.plan_weeks ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_write ON public.driver_absences TO authenticated USING (( SELECT public.plan_can_edit(driver_absences.agency_id) AS plan_can_edit)) WITH CHECK (( SELECT public.plan_can_edit(driver_absences.agency_id) AS plan_can_edit));

CREATE POLICY plan_write ON public.driver_roster TO authenticated USING (( SELECT public.plan_can_edit(driver_roster.agency_id) AS plan_can_edit)) WITH CHECK (( SELECT public.plan_can_edit(driver_roster.agency_id) AS plan_can_edit));

CREATE POLICY rh_read ON public.driver_absences FOR SELECT TO authenticated USING ((( SELECT public.is_rh() AS is_rh) AND (driver_code = ANY (( SELECT public.rh_driver_codes() AS rh_driver_codes)::text[]))));

CREATE POLICY rh_read ON public.driver_plan FOR SELECT TO authenticated USING ((( SELECT public.is_rh() AS is_rh) AND (driver_code = ANY (( SELECT public.rh_driver_codes() AS rh_driver_codes)::text[]))));

CREATE POLICY rh_write ON public.driver_absences TO authenticated USING ((( SELECT public.is_rh() AS is_rh) AND (driver_code = ANY (( SELECT public.rh_driver_codes() AS rh_driver_codes)::text[])))) WITH CHECK ((( SELECT public.is_rh() AS is_rh) AND (driver_code = ANY (( SELECT public.rh_driver_codes() AS rh_driver_codes)::text[]))));

-- ----------------------------------------------------------------------------- Droits et commentaires

GRANT ALL ON FUNCTION public.plan_absence_guard() TO anon;
GRANT ALL ON FUNCTION public.plan_absence_guard() TO authenticated;
GRANT ALL ON FUNCTION public.plan_absence_guard() TO service_role;

GRANT ALL ON FUNCTION public.plan_log_trg() TO anon;
GRANT ALL ON FUNCTION public.plan_log_trg() TO authenticated;
GRANT ALL ON FUNCTION public.plan_log_trg() TO service_role;

REVOKE ALL ON FUNCTION public.plan_replace_driver(p_agency bigint, p_old text, p_new text, p_from date, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.plan_replace_driver(p_agency bigint, p_old text, p_new text, p_from date, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.plan_replace_driver(p_agency bigint, p_old text, p_new text, p_from date, p_reason text) TO service_role;

REVOKE ALL ON FUNCTION public.plan_save(p_agency bigint, p_from date, p_to date, p_cells jsonb, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.plan_save(p_agency bigint, p_from date, p_to date, p_cells jsonb, p_note text) TO authenticated;
GRANT ALL ON FUNCTION public.plan_save(p_agency bigint, p_from date, p_to date, p_cells jsonb, p_note text) TO service_role;

REVOKE ALL ON FUNCTION public.plan_week_set(p_agency bigint, p_week date, p_action text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.plan_week_set(p_agency bigint, p_week date, p_action text) TO authenticated;
GRANT ALL ON FUNCTION public.plan_week_set(p_agency bigint, p_week date, p_action text) TO service_role;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.driver_absences TO authenticated;
GRANT ALL ON TABLE public.driver_absences TO service_role;

GRANT ALL ON SEQUENCE public.driver_absences_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.driver_absences_id_seq TO service_role;

GRANT SELECT ON TABLE public.driver_plan TO authenticated;
GRANT ALL ON TABLE public.driver_plan TO service_role;

GRANT ALL ON SEQUENCE public.driver_plan_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.driver_plan_id_seq TO service_role;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.driver_roster TO authenticated;
GRANT ALL ON TABLE public.driver_roster TO service_role;

GRANT SELECT ON TABLE public.plan_log TO authenticated;
GRANT ALL ON TABLE public.plan_log TO service_role;

GRANT ALL ON SEQUENCE public.plan_log_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.plan_log_id_seq TO service_role;

GRANT SELECT ON TABLE public.plan_weeks TO authenticated;
GRANT ALL ON TABLE public.plan_weeks TO service_role;
