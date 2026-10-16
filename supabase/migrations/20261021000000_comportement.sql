-- =============================================================================
-- Comportement chauffeur (16/10/2026) : un gestionnaire peut demander l'envoi par e-mail du PDF d'un chauffeur
-- de ses agences (demande « driver_report » traitée par le collecteur). L'administrateur le pouvait déjà.
-- À exécuter dans Supabase > SQL Editor (après 20261020000000_shifts.sql). Rejouable sans risque.
-- =============================================================================
drop policy if exists mgr_insert on public.jobs;
create policy mgr_insert on public.jobs for insert to authenticated
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and (
    kind in ('sync_now', 'recompute', 'after_inject', 'apply_plates')
    or (kind = 'driver_report' and case when coalesce(arg, '') ~ '^\s*\{' then (arg::jsonb ->> 'code') = any((select public.my_driver_codes())::text[]) else false end))));
