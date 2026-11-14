-- =============================================================================
-- Comptes, agences et droits (clés étrangères et droits : RLS, règles, GRANT)
-- Profils (rôle admin / manager / viewer / rh / pending), agences, rattachements, connexions en temps réel,
-- planning des gestionnaires, destinataires des alertes et des rapports. Fonctions de droits utilisées par toutes les règles RLS.
-- Tables : agencies, alert_recipients, manager_shifts, profiles, report_schedules, user_agencies, user_sessions
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Clés étrangères

ALTER TABLE ONLY public.alert_recipients
    ADD CONSTRAINT alert_recipients_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.manager_shifts
    ADD CONSTRAINT manager_shifts_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.manager_shifts
    ADD CONSTRAINT manager_shifts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.report_schedules
    ADD CONSTRAINT report_schedules_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_agencies
    ADD CONSTRAINT user_agencies_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_agencies
    ADD CONSTRAINT user_agencies_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------- Sécurité des lignes (RLS)

CREATE POLICY admin_all ON public.agencies TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_all ON public.alert_recipients TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_all ON public.manager_shifts TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_all ON public.report_schedules TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_all ON public.user_agencies TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_update ON public.profiles FOR UPDATE TO authenticated USING ((( SELECT public.my_role() AS my_role) = 'admin'::text)) WITH CHECK ((( SELECT public.my_role() AS my_role) = 'admin'::text));

ALTER TABLE public.agencies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.alert_recipients ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.manager_shifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY own_delete ON public.user_sessions FOR DELETE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((user_id = ( SELECT auth.uid() AS uid)) AND (last_seen < (now() - '30 days'::interval)))));

CREATE POLICY own_update ON public.user_sessions FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY own_write ON public.user_sessions FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY read_admin ON public.profiles FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY read_admin ON public.user_sessions FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (user_id = ( SELECT auth.uid() AS uid))));

CREATE POLICY read_agency ON public.agencies FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))));

CREATE POLICY read_agency ON public.manager_shifts FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))));

CREATE POLICY read_own ON public.profiles FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY read_own ON public.user_agencies FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (user_id = ( SELECT auth.uid() AS uid))));

ALTER TABLE public.report_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY rh_read ON public.agencies FOR SELECT TO authenticated USING (( SELECT public.is_rh() AS is_rh));

CREATE POLICY rh_read ON public.profiles FOR SELECT TO authenticated USING (( SELECT public.is_rh() AS is_rh));

CREATE POLICY rh_read ON public.user_sessions FOR SELECT TO authenticated USING ((( SELECT public.is_rh() AS is_rh) AND (user_id = ANY (( SELECT public.rh_staff_users() AS rh_staff_users)::uuid[]))));

ALTER TABLE public.user_agencies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------- Droits et commentaires

GRANT ALL ON FUNCTION public.handle_new_user() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;

REVOKE ALL ON FUNCTION public.menu_set(p_menu jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.menu_set(p_menu jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.menu_set(p_menu jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.session_ping(p_id text, p_page text, p_client text, p_active boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.session_ping(p_id text, p_page text, p_client text, p_active boolean) TO authenticated;
GRANT ALL ON FUNCTION public.session_ping(p_id text, p_page text, p_client text, p_active boolean) TO service_role;

REVOKE ALL ON FUNCTION public.shift_plan(p_day date, p_shift text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.shift_plan(p_day date, p_shift text) TO authenticated;
GRANT ALL ON FUNCTION public.shift_plan(p_day date, p_shift text) TO service_role;

REVOKE ALL ON FUNCTION public.user_sessions_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_sessions_guard() TO authenticated;
GRANT ALL ON FUNCTION public.user_sessions_guard() TO service_role;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agencies TO authenticated;
GRANT ALL ON TABLE public.agencies TO service_role;

GRANT UPDATE(cash_sheet_id) ON TABLE public.agencies TO authenticated;

GRANT ALL ON SEQUENCE public.agencies_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.agencies_id_seq TO service_role;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.alert_recipients TO authenticated;
GRANT ALL ON TABLE public.alert_recipients TO service_role;

GRANT ALL ON SEQUENCE public.alert_recipients_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.alert_recipients_id_seq TO service_role;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.manager_shifts TO authenticated;
GRANT ALL ON TABLE public.manager_shifts TO service_role;

GRANT SELECT ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;

GRANT UPDATE(name) ON TABLE public.profiles TO authenticated;

GRANT UPDATE(role) ON TABLE public.profiles TO authenticated;

GRANT UPDATE(pages) ON TABLE public.profiles TO authenticated;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.report_schedules TO authenticated;
GRANT ALL ON TABLE public.report_schedules TO service_role;

GRANT ALL ON SEQUENCE public.report_schedules_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.report_schedules_id_seq TO service_role;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_agencies TO authenticated;
GRANT ALL ON TABLE public.user_agencies TO service_role;

GRANT SELECT,DELETE ON TABLE public.user_sessions TO authenticated;
GRANT ALL ON TABLE public.user_sessions TO service_role;

GRANT INSERT(id) ON TABLE public.user_sessions TO authenticated;

GRANT UPDATE(last_seen) ON TABLE public.user_sessions TO authenticated;

GRANT INSERT(page),UPDATE(page) ON TABLE public.user_sessions TO authenticated;

GRANT INSERT(client),UPDATE(client) ON TABLE public.user_sessions TO authenticated;

GRANT INSERT(active),UPDATE(active) ON TABLE public.user_sessions TO authenticated;
