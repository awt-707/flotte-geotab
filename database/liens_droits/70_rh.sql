-- =============================================================================
-- Ressources humaines et contrats de travail (clés étrangères et droits : RLS, règles, GRANT)
-- Salariés (chauffeurs et staff), événements (congés, absences, avances, avenants…), pointage du staff, dossiers,
-- sociétés employeuses et contrats de travail. Rôle « rh » limité ou non à des agences (rh_scope).
-- Tables : employers, hr_clock, hr_documents, hr_employees, hr_events, work_contracts
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Clés étrangères

ALTER TABLE ONLY public.hr_clock
    ADD CONSTRAINT hr_clock_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.hr_documents
    ADD CONSTRAINT hr_documents_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_employer_id_fkey FOREIGN KEY (employer_id) REFERENCES public.employers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE SET NULL;

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_work_contract_id_fkey FOREIGN KEY (work_contract_id) REFERENCES public.work_contracts(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.hr_events
    ADD CONSTRAINT hr_events_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.work_contracts
    ADD CONSTRAINT work_contracts_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id);

ALTER TABLE ONLY public.work_contracts
    ADD CONSTRAINT work_contracts_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.work_contracts
    ADD CONSTRAINT work_contracts_employer_id_fkey FOREIGN KEY (employer_id) REFERENCES public.employers(id);

-- ----------------------------------------------------------------------------- Sécurité des lignes (RLS)

CREATE POLICY admin_all ON public.employers TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (( SELECT public.is_rh() AS is_rh) AND (cardinality(COALESCE(( SELECT public.rh_agency_ids() AS rh_agency_ids), '{}'::bigint[])) = 0)))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR (( SELECT public.is_rh() AS is_rh) AND (cardinality(COALESCE(( SELECT public.rh_agency_ids() AS rh_agency_ids), '{}'::bigint[])) = 0))));

CREATE POLICY admin_delete ON public.work_contracts FOR DELETE TO authenticated USING (public.rh_scope(agency_id));

ALTER TABLE public.employers ENABLE ROW LEVEL SECURITY;

CREATE POLICY hr_admin ON public.hr_clock TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (( SELECT public.is_rh() AS is_rh) AND public.hr_can_emp(employee_id)))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR (( SELECT public.is_rh() AS is_rh) AND public.hr_can_emp(employee_id))));

ALTER TABLE public.hr_clock ENABLE ROW LEVEL SECURITY;

CREATE POLICY hr_delete ON public.hr_documents FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (( SELECT public.is_rh() AS is_rh) AND public.hr_can_emp(employee_id))));

CREATE POLICY hr_delete ON public.hr_employees FOR DELETE TO authenticated USING (public.rh_scope(agency_id));

CREATE POLICY hr_delete ON public.hr_events FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (( SELECT public.is_rh() AS is_rh) AND public.hr_can_emp(employee_id))));

ALTER TABLE public.hr_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.hr_employees ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.hr_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY hr_insert ON public.hr_documents FOR INSERT TO authenticated WITH CHECK (public.hr_can_emp(employee_id));

CREATE POLICY hr_insert ON public.hr_employees FOR INSERT TO authenticated WITH CHECK (public.hr_can(kind, agency_id));

CREATE POLICY hr_insert ON public.hr_events FOR INSERT TO authenticated WITH CHECK (public.hr_can_emp(employee_id));

CREATE POLICY hr_read ON public.hr_clock FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (user_id = ( SELECT auth.uid() AS uid)) OR (( SELECT public.is_rh() AS is_rh) AND public.hr_can_emp(employee_id))));

CREATE POLICY hr_read ON public.hr_documents FOR SELECT TO authenticated USING (public.hr_can_emp(employee_id));

CREATE POLICY hr_read ON public.hr_employees FOR SELECT TO authenticated USING (public.hr_can(kind, agency_id));

CREATE POLICY hr_read ON public.hr_events FOR SELECT TO authenticated USING (public.hr_can_emp(employee_id));

CREATE POLICY hr_update ON public.hr_documents FOR UPDATE TO authenticated USING (public.hr_can_emp(employee_id)) WITH CHECK (public.hr_can_emp(employee_id));

CREATE POLICY hr_update ON public.hr_employees FOR UPDATE TO authenticated USING (public.hr_can(kind, agency_id)) WITH CHECK (public.hr_can(kind, agency_id));

CREATE POLICY hr_update ON public.hr_events FOR UPDATE TO authenticated USING (public.hr_can_emp(employee_id)) WITH CHECK (public.hr_can_emp(employee_id));

CREATE POLICY mgr_insert ON public.work_contracts FOR INSERT TO authenticated WITH CHECK ((public.wc_can(agency_id) AND ((employee_id IS NULL) OR public.hr_can_emp(employee_id)) AND ((model = 'chauffeur'::text) OR public.rh_scope(agency_id))));

CREATE POLICY mgr_update ON public.work_contracts FOR UPDATE TO authenticated USING ((public.wc_can(agency_id) AND ((employee_id IS NULL) OR public.hr_can_emp(employee_id)) AND ((model = 'chauffeur'::text) OR public.rh_scope(agency_id)))) WITH CHECK ((public.wc_can(agency_id) AND ((employee_id IS NULL) OR public.hr_can_emp(employee_id)) AND ((model = 'chauffeur'::text) OR public.rh_scope(agency_id))));

CREATE POLICY read_agency ON public.work_contracts FOR SELECT TO authenticated USING ((public.wc_can(agency_id) AND ((employee_id IS NULL) OR public.hr_can_emp(employee_id)) AND ((model = 'chauffeur'::text) OR public.rh_scope(agency_id))));

CREATE POLICY read_mgr ON public.employers FOR SELECT TO authenticated USING ((( SELECT public.my_role() AS my_role) = ANY (ARRAY['admin'::text, 'manager'::text, 'rh'::text])));

ALTER TABLE public.work_contracts ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------- Droits et commentaires

GRANT ALL ON FUNCTION public.employers_touch() TO anon;
GRANT ALL ON FUNCTION public.employers_touch() TO authenticated;
GRANT ALL ON FUNCTION public.employers_touch() TO service_role;

REVOKE ALL ON FUNCTION public.hr_clock_do(p_kind text, p_birth date, p_client text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hr_clock_do(p_kind text, p_birth date, p_client text) TO authenticated;
GRANT ALL ON FUNCTION public.hr_clock_do(p_kind text, p_birth date, p_client text) TO service_role;

REVOKE ALL ON FUNCTION public.hr_me() FROM PUBLIC;
GRANT ALL ON FUNCTION public.hr_me() TO authenticated;
GRANT ALL ON FUNCTION public.hr_me() TO service_role;

REVOKE ALL ON FUNCTION public.hr_state(p_emp bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hr_state(p_emp bigint) TO service_role;

GRANT ALL ON FUNCTION public.hr_touch() TO anon;
GRANT ALL ON FUNCTION public.hr_touch() TO authenticated;
GRANT ALL ON FUNCTION public.hr_touch() TO service_role;

GRANT ALL ON FUNCTION public.hr_user_guard() TO anon;
GRANT ALL ON FUNCTION public.hr_user_guard() TO authenticated;
GRANT ALL ON FUNCTION public.hr_user_guard() TO service_role;

GRANT ALL ON FUNCTION public.rh_drive_reset() TO anon;
GRANT ALL ON FUNCTION public.rh_drive_reset() TO authenticated;
GRANT ALL ON FUNCTION public.rh_drive_reset() TO service_role;

REVOKE ALL ON FUNCTION public.rh_drive_set(p_agency bigint, p_data jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rh_drive_set(p_agency bigint, p_data jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.rh_drive_set(p_agency bigint, p_data jsonb) TO service_role;

GRANT ALL ON FUNCTION public.work_contracts_guard() TO anon;
GRANT ALL ON FUNCTION public.work_contracts_guard() TO authenticated;
GRANT ALL ON FUNCTION public.work_contracts_guard() TO service_role;

GRANT ALL ON TABLE public.employers TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.employers TO authenticated;

GRANT ALL ON SEQUENCE public.employers_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.employers_id_seq TO service_role;

GRANT ALL ON TABLE public.hr_clock TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hr_clock TO authenticated;

GRANT ALL ON SEQUENCE public.hr_clock_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.hr_clock_id_seq TO service_role;

GRANT ALL ON TABLE public.hr_documents TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hr_documents TO authenticated;

GRANT ALL ON SEQUENCE public.hr_documents_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.hr_documents_id_seq TO service_role;

GRANT ALL ON TABLE public.hr_employees TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hr_employees TO authenticated;

GRANT ALL ON SEQUENCE public.hr_employees_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.hr_employees_id_seq TO service_role;

GRANT ALL ON TABLE public.hr_events TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hr_events TO authenticated;

GRANT ALL ON SEQUENCE public.hr_events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.hr_events_id_seq TO service_role;

GRANT ALL ON TABLE public.work_contracts TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.work_contracts TO authenticated;

GRANT ALL ON SEQUENCE public.work_contracts_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.work_contracts_id_seq TO service_role;
