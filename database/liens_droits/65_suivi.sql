-- =============================================================================
-- Pauses chauffeurs et suivi des courses privées (clés étrangères et droits : RLS, règles, GRANT)
-- Pauses déclenchées par le gestionnaire (2 h par chauffeur et par shift, véhicule qui bouge pendant la pause noté),
-- suivi d'une course privée de la prise en charge à l'arrivée (positions GPS Geotab relevées).
-- Tables : driver_pauses, mission_tracks
-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main
-- (ajouter une migration, puis relancer build).
-- =============================================================================
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

-- ----------------------------------------------------------------------------- Clés étrangères

ALTER TABLE ONLY public.driver_pauses
    ADD CONSTRAINT driver_pauses_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.mission_tracks
    ADD CONSTRAINT mission_tracks_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.agencies(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.mission_tracks
    ADD CONSTRAINT mission_tracks_mission_id_fkey FOREIGN KEY (mission_id) REFERENCES public.missions(id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------- Sécurité des lignes (RLS)

ALTER TABLE public.driver_pauses ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.mission_tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY sv_del ON public.driver_pauses FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY sv_del ON public.mission_tracks FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));

CREATE POLICY sv_ins ON public.driver_pauses FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

CREATE POLICY sv_ins ON public.mission_tracks FOR INSERT TO authenticated WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])) AND (EXISTS ( SELECT 1
   FROM public.missions m
  WHERE (m.id = mission_tracks.mission_id))))));

CREATE POLICY sv_read ON public.driver_pauses FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])) OR (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))));

CREATE POLICY sv_read ON public.mission_tracks FOR SELECT TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])) OR (agency_id = ANY (( SELECT public.my_agency_ids() AS my_agency_ids)::bigint[]))));

CREATE POLICY sv_upd ON public.driver_pauses FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

CREATE POLICY sv_upd ON public.mission_tracks FOR UPDATE TO authenticated USING ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[]))))) WITH CHECK ((( SELECT public.is_admin() AS is_admin) OR ((( SELECT public.my_role() AS my_role) = 'manager'::text) AND (vehicle_key = ANY (( SELECT public.my_vehicle_keys() AS my_vehicle_keys)::text[])))));

-- ----------------------------------------------------------------------------- Droits et commentaires

REVOKE ALL ON FUNCTION public.suivi_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.suivi_guard() TO authenticated;
GRANT ALL ON FUNCTION public.suivi_guard() TO service_role;

GRANT ALL ON TABLE public.driver_pauses TO service_role;
GRANT SELECT,DELETE ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(agency_id) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(vehicle_key) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(plate) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(driver_code) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(driver_name) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(driver_phone) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(contract_num) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(shift_day) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(shift) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(planned_min),UPDATE(planned_min) ON TABLE public.driver_pauses TO authenticated;

GRANT UPDATE(ended_at) ON TABLE public.driver_pauses TO authenticated;

GRANT UPDATE(end_reason) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(start_lat) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(start_lon) ON TABLE public.driver_pauses TO authenticated;

GRANT UPDATE(moved_at) ON TABLE public.driver_pauses TO authenticated;

GRANT UPDATE(moved_m) ON TABLE public.driver_pauses TO authenticated;

GRANT UPDATE(moved_note) ON TABLE public.driver_pauses TO authenticated;

GRANT INSERT(note),UPDATE(note) ON TABLE public.driver_pauses TO authenticated;

GRANT ALL ON SEQUENCE public.driver_pauses_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.driver_pauses_id_seq TO service_role;

GRANT ALL ON TABLE public.mission_tracks TO service_role;
GRANT SELECT,DELETE ON TABLE public.mission_tracks TO authenticated;

GRANT INSERT(mission_id) ON TABLE public.mission_tracks TO authenticated;

GRANT INSERT(agency_id) ON TABLE public.mission_tracks TO authenticated;

GRANT INSERT(vehicle_key) ON TABLE public.mission_tracks TO authenticated;

GRANT INSERT(plate) ON TABLE public.mission_tracks TO authenticated;

GRANT INSERT(driver_name) ON TABLE public.mission_tracks TO authenticated;

GRANT INSERT(driver_phone) ON TABLE public.mission_tracks TO authenticated;

GRANT INSERT(dest_label),UPDATE(dest_label) ON TABLE public.mission_tracks TO authenticated;

GRANT INSERT(dest_lat),UPDATE(dest_lat) ON TABLE public.mission_tracks TO authenticated;

GRANT INSERT(dest_lon),UPDATE(dest_lon) ON TABLE public.mission_tracks TO authenticated;

GRANT UPDATE(arrived_at) ON TABLE public.mission_tracks TO authenticated;

GRANT UPDATE(ended_at) ON TABLE public.mission_tracks TO authenticated;

GRANT UPDATE(end_reason) ON TABLE public.mission_tracks TO authenticated;

GRANT INSERT(points),UPDATE(points) ON TABLE public.mission_tracks TO authenticated;

GRANT ALL ON SEQUENCE public.mission_tracks_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.mission_tracks_id_seq TO service_role;
