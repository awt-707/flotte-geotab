-- =============================================================================
-- Flotte : véhicules, parc, données Geotab, alertes, journal (clés étrangères et droits : RLS, règles, GRANT)
-- Véhicules et parc (plaques, agences, sociétés), changements de plaque, données Geotab finalisées ou en direct
-- (trajets, ralentis, arrêts moteur, événements, carburant, jauge), alertes, journal par contrat, tickets de carte carburant.
-- Tables : alerts, engine_stops, events, fuel, fuel_card_tx, idles, journal, levels, live_status, parc, plate_changes, trips, vehicle_days, vehicles
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Clés étrangères

ALTER TABLE ONLY public.parc
    ADD CONSTRAINT parc_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.parc
    ADD CONSTRAINT parc_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.manifest_config(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------- Sécurité des lignes (RLS)

CREATE POLICY admin_all ON public.parc TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));

CREATE POLICY admin_update ON public.vehicles FOR UPDATE TO authenticated USING ((( SELECT public.my_role() AS my_role) = 'admin'::text)) WITH CHECK ((( SELECT public.my_role() AS my_role) = 'admin'::text));

ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.engine_stops ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.fuel ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.fuel_card_tx ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.idles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.journal ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.levels ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.live_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY mgr_all ON public.plate_changes TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND ((public.norm_plate(old_plate) = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])) OR (public.norm_plate(new_plate) = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND ((public.norm_plate(old_plate) = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])) OR (public.norm_plate(new_plate) = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))))));

CREATE POLICY mgr_update ON public.alerts FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

CREATE POLICY mgr_update ON public.fuel FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

CREATE POLICY mgr_update ON public.fuel_card_tx FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

ALTER TABLE public.parc ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.plate_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY read_agency ON public.alerts FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.engine_stops FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.events FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.fuel FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.fuel_card_tx FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.idles FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.journal FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.levels FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.live_status FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.parc FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))));

CREATE POLICY read_agency ON public.plate_changes FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (public.norm_plate(old_plate) = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])) OR (public.norm_plate(new_plate) = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.trips FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.vehicle_days FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

CREATE POLICY read_agency ON public.vehicles FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))));

ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.vehicle_days ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------- Droits et commentaires

REVOKE ALL ON FUNCTION public.alert_counts(p_from date, p_to date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.alert_counts(p_from date, p_to date) TO authenticated;
GRANT ALL ON FUNCTION public.alert_counts(p_from date, p_to date) TO service_role;

REVOKE ALL ON FUNCTION public.driver_rule_counts(p_from date, p_to date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_rule_counts(p_from date, p_to date) TO authenticated;
GRANT ALL ON FUNCTION public.driver_rule_counts(p_from date, p_to date) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_vdays(p_keys text[], p_trips jsonb, p_idles jsonb, p_events jsonb, p_fuel jsonb, p_levels jsonb, p_sync jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_vdays(p_keys text[], p_trips jsonb, p_idles jsonb, p_events jsonb, p_fuel jsonb, p_levels jsonb, p_sync jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_vdays(p_keys text[], p_trips jsonb, p_idles jsonb, p_events jsonb, p_fuel jsonb, p_levels jsonb, p_sync jsonb, p_stops jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_vdays(p_keys text[], p_trips jsonb, p_idles jsonb, p_events jsonb, p_fuel jsonb, p_levels jsonb, p_sync jsonb, p_stops jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.import_fuel_card(p_rows jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.import_fuel_card(p_rows jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.import_fuel_card(p_rows jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.key_stats() FROM PUBLIC;
GRANT ALL ON FUNCTION public.key_stats() TO service_role;

REVOKE ALL ON FUNCTION public.mark_notified(p_ids text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_notified(p_ids text[]) TO service_role;

REVOKE ALL ON FUNCTION public.parc_agency_for(p_key text, p_plate text, p_others text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.parc_agency_for(p_key text, p_plate text, p_others text) TO service_role;

GRANT ALL ON FUNCTION public.parc_agency_trg() TO anon;
GRANT ALL ON FUNCTION public.parc_agency_trg() TO authenticated;
GRANT ALL ON FUNCTION public.parc_agency_trg() TO service_role;

REVOKE ALL ON FUNCTION public.purge_before(p_table text, p_before date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.purge_before(p_table text, p_before date) TO service_role;

REVOKE ALL ON FUNCTION public.put_rows(p_table text, p_keys text[], p_rows jsonb, p_final boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.put_rows(p_table text, p_keys text[], p_rows jsonb, p_final boolean) TO service_role;

REVOKE ALL ON FUNCTION public.rekey_vehicle(p_alias text, p_canon text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rekey_vehicle(p_alias text, p_canon text) TO service_role;

REVOKE ALL ON FUNCTION public.replace_alerts(p_cut date, p_rows jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.replace_alerts(p_cut date, p_rows jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.replace_journal(p_cut date, p_rows jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.replace_journal(p_cut date, p_rows jsonb) TO service_role;

GRANT ALL ON FUNCTION public.vehicles_agency_trg() TO anon;
GRANT ALL ON FUNCTION public.vehicles_agency_trg() TO authenticated;
GRANT ALL ON FUNCTION public.vehicles_agency_trg() TO service_role;

GRANT SELECT ON TABLE public.alerts TO authenticated;
GRANT ALL ON TABLE public.alerts TO service_role;

GRANT UPDATE(status) ON TABLE public.alerts TO authenticated;

GRANT UPDATE(comment) ON TABLE public.alerts TO authenticated;

GRANT SELECT ON TABLE public.engine_stops TO authenticated;
GRANT ALL ON TABLE public.engine_stops TO service_role;

GRANT SELECT ON TABLE public.events TO authenticated;
GRANT ALL ON TABLE public.events TO service_role;

GRANT SELECT ON TABLE public.fuel TO authenticated;
GRANT ALL ON TABLE public.fuel TO service_role;

GRANT UPDATE(status) ON TABLE public.fuel TO authenticated;

GRANT SELECT ON TABLE public.fuel_card_tx TO authenticated;
GRANT ALL ON TABLE public.fuel_card_tx TO service_role;

GRANT UPDATE(status) ON TABLE public.fuel_card_tx TO authenticated;

GRANT UPDATE(note) ON TABLE public.fuel_card_tx TO authenticated;

GRANT SELECT ON TABLE public.idles TO authenticated;
GRANT ALL ON TABLE public.idles TO service_role;

GRANT SELECT ON TABLE public.journal TO authenticated;
GRANT ALL ON TABLE public.journal TO service_role;

GRANT SELECT ON TABLE public.levels TO authenticated;
GRANT ALL ON TABLE public.levels TO service_role;

GRANT SELECT ON TABLE public.live_status TO authenticated;
GRANT ALL ON TABLE public.live_status TO service_role;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.parc TO authenticated;
GRANT ALL ON TABLE public.parc TO service_role;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.plate_changes TO authenticated;
GRANT ALL ON TABLE public.plate_changes TO service_role;

GRANT ALL ON SEQUENCE public.plate_changes_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.plate_changes_id_seq TO service_role;

GRANT SELECT ON TABLE public.trips TO authenticated;
GRANT ALL ON TABLE public.trips TO service_role;

GRANT SELECT ON TABLE public.vehicle_days TO authenticated;
GRANT ALL ON TABLE public.vehicle_days TO service_role;

GRANT SELECT ON TABLE public.vehicles TO authenticated;
GRANT ALL ON TABLE public.vehicles TO service_role;

GRANT UPDATE(tank_l) ON TABLE public.vehicles TO authenticated;

GRANT UPDATE(ref_l100) ON TABLE public.vehicles TO authenticated;

GRANT UPDATE(revenue) ON TABLE public.vehicles TO authenticated;

GRANT UPDATE(active) ON TABLE public.vehicles TO authenticated;

GRANT UPDATE(agency_id) ON TABLE public.vehicles TO authenticated;
