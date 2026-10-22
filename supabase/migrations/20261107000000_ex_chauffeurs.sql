-- =============================================================================
-- Planning chauffeurs : départ d'un chauffeur et remplacement (22/10/2026, demande d'Ahmed). À exécuter dans Supabase > SQL Editor
-- (après 20261106000000_planning_chauffeurs.sql). Rejouable sans risque.
-- - driver_roster : date de départ, motif, remplaçant (ex-chauffeur = parti, jamais planifié ni proposé)
-- - plan_replace_driver : le remplaçant reprend les réglages (shift, véhicule, repos) et les cases déjà planifiées de l'ancien
--   à partir de la date choisie ; un jour où le remplaçant travaille déjà, la case reste à pourvoir (signalée) ; historique
-- =============================================================================
alter table public.driver_roster add column if not exists left_at date;
alter table public.driver_roster add column if not exists left_reason text;
alter table public.driver_roster add column if not exists replaced_by text;

create or replace function public.plan_replace_driver(p_agency bigint, p_old text, p_new text, p_from date, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w date; r driver_roster; n_moved integer := 0; n_free integer := 0;
begin
  if p_old is null or p_new is null or p_old = p_new then raise exception 'choisir le chauffeur qui part et son remplaçant'; end if;
  if not plan_can_edit(p_agency, null) then raise exception 'modification du planning non autorisée'; end if;
  for w in select distinct (day - (extract(isodow from day)::int - 1))::date from driver_plan where agency_id = p_agency and driver_code = p_old and day >= p_from loop
    if not plan_can_edit(p_agency, w) then raise exception 'semaine du % verrouillée : remplacement impossible', to_char(w, 'DD/MM/YYYY'); end if;
  end loop;
  -- cases de l'ancien : au remplaçant, sauf les jours où il travaille déjà (case à pourvoir)
  with free as (
    update driver_plan p set driver_code = null, locked = false, note = 'à pourvoir : ' || p_old || ' parti, remplaçant déjà en service ce jour', updated_at = now(), updated_by = auth.uid()
     where p.agency_id = p_agency and p.driver_code = p_old and p.day >= p_from
       and exists (select 1 from driver_plan x where x.agency_id = p_agency and x.day = p.day and x.driver_code = p_new)
    returning 1)
  select count(*) into n_free from free;
  with moved as (
    update driver_plan set driver_code = p_new, updated_at = now(), updated_by = auth.uid()
     where agency_id = p_agency and driver_code = p_old and day >= p_from returning 1)
  select count(*) into n_moved from moved;
  -- réglages repris par le remplaçant ; l'ancien devient ex-chauffeur
  select * into r from driver_roster where driver_code = p_old;
  insert into driver_roster (driver_code, agency_id, shift, vehicle_key, off_days, active, left_at, left_reason, replaced_by, updated_at, updated_by)
  values (p_new, p_agency, r.shift, r.vehicle_key, coalesce(r.off_days, '{}'), true, null, null, null, now(), auth.uid())
  on conflict (driver_code) do update set agency_id = p_agency, shift = coalesce(excluded.shift, driver_roster.shift), vehicle_key = coalesce(excluded.vehicle_key, driver_roster.vehicle_key),
    off_days = case when cardinality(excluded.off_days) = 2 then excluded.off_days else driver_roster.off_days end, active = true, left_at = null, left_reason = null, replaced_by = null,
    updated_at = now(), updated_by = auth.uid();
  insert into driver_roster (driver_code, agency_id, active, left_at, left_reason, replaced_by, updated_at, updated_by)
  values (p_old, p_agency, false, p_from, p_reason, p_new, now(), auth.uid())
  on conflict (driver_code) do update set active = false, left_at = p_from, left_reason = p_reason, replaced_by = p_new, updated_at = now(), updated_by = auth.uid();
  insert into plan_log (agency_id, action, detail) values (p_agency, 'départ', p_old || ' remplacé par ' || p_new || ' à partir du ' || to_char(p_from, 'DD/MM/YYYY')
    || ' : ' || n_moved || ' shift(s) repris' || case when n_free > 0 then ', ' || n_free || ' à pourvoir' else '' end || coalesce(' · ' || p_reason, ''));
  return jsonb_build_object('moved', n_moved, 'free', n_free);
end $$;
revoke execute on function public.plan_replace_driver(bigint, text, text, date, text) from public, anon;
grant execute on function public.plan_replace_driver(bigint, text, text, date, text) to authenticated;
