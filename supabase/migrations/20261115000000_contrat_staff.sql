-- =============================================================================
-- Contrats de travail du staff (26/10/2026, demande d'Ahmed : chef d'agence, gestionnaire… et pas seulement chauffeur).
-- À exécuter dans Supabase > SQL Editor (après 20261114000000_rh_drive.sql). Rejouable sans risque.
-- - work_contracts.model : 'chauffeur' (modèle bilingue) ou 'staff' (modèle en français, intitulé du poste au choix)
-- - un contrat du staff n'est jamais lu, créé ni modifié par un gestionnaire (administrateur et ressources humaines seulement),
--   même avant d'être rattaché à la fiche du salarié
-- =============================================================================
alter table public.work_contracts add column if not exists model text not null default 'chauffeur';
alter table public.work_contracts drop constraint if exists work_contracts_model_check;
alter table public.work_contracts add constraint work_contracts_model_check check (model in ('chauffeur', 'staff'));

drop policy if exists read_agency on public.work_contracts;
drop policy if exists mgr_insert on public.work_contracts;
drop policy if exists mgr_update on public.work_contracts;
create policy read_agency on public.work_contracts for select to authenticated
  using (public.wc_can(agency_id) and (employee_id is null or public.hr_can_emp(employee_id)) and (model = 'chauffeur' or public.rh_scope(agency_id)));
create policy mgr_insert on public.work_contracts for insert to authenticated
  with check (public.wc_can(agency_id) and (employee_id is null or public.hr_can_emp(employee_id)) and (model = 'chauffeur' or public.rh_scope(agency_id)));
create policy mgr_update on public.work_contracts for update to authenticated
  using (public.wc_can(agency_id) and (employee_id is null or public.hr_can_emp(employee_id)) and (model = 'chauffeur' or public.rh_scope(agency_id)))
  with check (public.wc_can(agency_id) and (employee_id is null or public.hr_can_emp(employee_id)) and (model = 'chauffeur' or public.rh_scope(agency_id)));
