-- =============================================================================
-- Caisse : encaissements, dépenses, Uber, Bolt, justificatifs (clés étrangères et droits : RLS, règles, GRANT)
-- Journal unique des mouvements (cash_moves, garde cash_guard, historique cash_log), exports Uber et Bolt,
-- fiches d'encaissement et justificatifs déposés (cash_sheets, cash_files),
-- contrôle des courses Uber (export « Activité des courses » croisé avec le GPS Geotab : uber_trips, uber_days).
-- Tables : bolt_sessions, cash_files, cash_log, cash_moves, cash_sheets, uber_days, uber_drivers, uber_payments, uber_trips
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Clés étrangères

ALTER TABLE ONLY public.bolt_sessions
    ADD CONSTRAINT bolt_sessions_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.cash_files
    ADD CONSTRAINT cash_files_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.cash_files
    ADD CONSTRAINT cash_files_move_id_fkey FOREIGN KEY (move_id) REFERENCES public.cash_moves(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.cash_moves
    ADD CONSTRAINT cash_moves_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.cash_moves
    ADD CONSTRAINT cash_moves_mission_id_fkey FOREIGN KEY (mission_id) REFERENCES public.missions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.cash_sheets
    ADD CONSTRAINT cash_sheets_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.uber_days
    ADD CONSTRAINT uber_days_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.uber_drivers
    ADD CONSTRAINT uber_drivers_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.uber_payments
    ADD CONSTRAINT uber_payments_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.uber_trips
    ADD CONSTRAINT uber_trips_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------- Sécurité des lignes (RLS)

CREATE POLICY admin_delete ON public.bolt_sessions FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_delete ON public.cash_moves FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_delete ON public.uber_drivers FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_delete ON public.uber_payments FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

ALTER TABLE public.bolt_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cash_files ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cash_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cash_moves ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cash_sheets ENABLE ROW LEVEL SECURITY;

CREATE POLICY files_del ON public.cash_files FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY files_ins ON public.cash_files FOR INSERT TO authenticated WITH CHECK (((created_by = ( SELECT auth.uid() AS uid)) AND (drive_id IS NULL) AND (( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))) AND ((move_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.cash_moves m
  WHERE ((m.id = cash_files.move_id) AND (NOT (m.agency_id IS DISTINCT FROM cash_files.agency_id))))))));

CREATE POLICY files_read ON public.cash_files FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY mgr_all ON public.bolt_sessions FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY mgr_all ON public.uber_drivers FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY mgr_all ON public.uber_payments FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY mgr_ins ON public.bolt_sessions FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY mgr_ins ON public.uber_drivers FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY mgr_ins ON public.uber_payments FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY mgr_insert ON public.cash_moves FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY mgr_upd ON public.uber_drivers FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY mgr_upd ON public.uber_payments FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY mgr_update ON public.cash_moves FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY read_admin ON public.cash_log FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY read_mgr ON public.cash_moves FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY rh_read ON public.cash_moves FOR SELECT TO authenticated USING ((( SELECT public.is_rh() AS is_rh) AND (kind = ANY (ARRAY['avance'::text, 'remboursement'::text, 'bonus'::text])) AND (driver_code = ANY (( SELECT public.rh_driver_codes() AS rh_driver_codes)::text[]))));

CREATE POLICY sheets_del ON public.cash_sheets FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY sheets_ins ON public.cash_sheets FOR INSERT TO authenticated WITH CHECK (((created_by = ( SELECT auth.uid() AS uid)) AND (( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))))));

CREATE POLICY sheets_read ON public.cash_sheets FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[])))));

CREATE POLICY ub_del ON public.uber_trips FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY ub_read ON public.uber_trips FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])) OR (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))));

CREATE POLICY ub_upd ON public.uber_trips FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

CREATE POLICY ubd_del ON public.uber_days FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY ubd_ins ON public.uber_days FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

CREATE POLICY ubd_read ON public.uber_days FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])) OR (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))));

CREATE POLICY ubd_upd ON public.uber_days FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

ALTER TABLE public.uber_days ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.uber_drivers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.uber_payments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.uber_trips ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------- Droits et commentaires

GRANT ALL ON FUNCTION public.cash_agency_trg() TO anon;
GRANT ALL ON FUNCTION public.cash_agency_trg() TO authenticated;
GRANT ALL ON FUNCTION public.cash_agency_trg() TO service_role;

GRANT ALL ON FUNCTION public.cash_guard() TO anon;
GRANT ALL ON FUNCTION public.cash_guard() TO authenticated;
GRANT ALL ON FUNCTION public.cash_guard() TO service_role;

GRANT ALL ON FUNCTION public.cash_log_trg() TO anon;
GRANT ALL ON FUNCTION public.cash_log_trg() TO authenticated;
GRANT ALL ON FUNCTION public.cash_log_trg() TO service_role;

REVOKE ALL ON FUNCTION public.import_uber_trips(p_rows jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.import_uber_trips(p_rows jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.import_uber_trips(p_rows jsonb) TO service_role;

GRANT SELECT,INSERT,DELETE ON TABLE public.bolt_sessions TO authenticated;
GRANT ALL ON TABLE public.bolt_sessions TO service_role;

GRANT SELECT,INSERT,DELETE ON TABLE public.cash_files TO authenticated;
GRANT ALL ON TABLE public.cash_files TO service_role;

GRANT ALL ON SEQUENCE public.cash_files_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.cash_files_id_seq TO service_role;

GRANT SELECT ON TABLE public.cash_log TO authenticated;
GRANT ALL ON TABLE public.cash_log TO service_role;

GRANT ALL ON SEQUENCE public.cash_log_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.cash_log_id_seq TO service_role;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cash_moves TO authenticated;
GRANT ALL ON TABLE public.cash_moves TO service_role;

GRANT ALL ON SEQUENCE public.cash_moves_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.cash_moves_id_seq TO service_role;

GRANT SELECT,INSERT,DELETE ON TABLE public.cash_sheets TO authenticated;
GRANT ALL ON TABLE public.cash_sheets TO service_role;

GRANT ALL ON SEQUENCE public.cash_sheets_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.cash_sheets_id_seq TO service_role;

GRANT ALL ON TABLE public.uber_days TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.uber_days TO authenticated;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.uber_drivers TO authenticated;
GRANT ALL ON TABLE public.uber_drivers TO service_role;

GRANT SELECT,INSERT,DELETE ON TABLE public.uber_payments TO authenticated;
GRANT ALL ON TABLE public.uber_payments TO service_role;

GRANT ALL ON TABLE public.uber_trips TO service_role;
GRANT SELECT,DELETE ON TABLE public.uber_trips TO authenticated;

GRANT UPDATE(pu_lat) ON TABLE public.uber_trips TO authenticated;

GRANT UPDATE(pu_lon) ON TABLE public.uber_trips TO authenticated;

GRANT UPDATE(pu_prec) ON TABLE public.uber_trips TO authenticated;

GRANT UPDATE(chk) ON TABLE public.uber_trips TO authenticated;

GRANT UPDATE(chk_at) ON TABLE public.uber_trips TO authenticated;
