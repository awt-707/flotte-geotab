-- =============================================================================
-- Ressources humaines, suite (24/10/2026, demande d'Ahmed). À exécuter dans Supabase > SQL Editor
-- (après 20261110000000_rh.sql). Rejouable sans risque.
-- - rôle « rh » (Ressources humaines) : accès aux seules ressources humaines (salariés chauffeurs et staff, salaires,
--   pointage, contrats de travail, sociétés, dossiers des salariés) ; rien d'autre de Ludy (flotte, caisse, alertes…).
--   RH rattaché à des agences (page Agences) : salariés de ces agences et salariés sans agence ; sans agence : tous.
--   Pour calculer les présences, il lit les contrats, le planning et les absences des chauffeurs de son périmètre,
--   les avances / remboursements / bonus de la caisse de ces chauffeurs et les connexions du staff.
-- - gestionnaires : accès RH aux chauffeurs de leurs agences tant que le réglage rhManagers vaut « oui » (par défaut).
-- - dossiers des salariés (hr_documents : CIN, permis, casier, CNSS, RIB…, dates d'expiration) dans le stockage « rh »
-- - suivi des contrats de travail : signé (date), légalisé (date, lieu, copie légalisée) ; contrat existant signé hors Ludy
-- - fiche : N° CNSS, type de contrat (CDI, CDD…) et fin du contrat, catégorie (cadre, employé, ouvrier : durée d'essai légale)
-- =============================================================================
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'manager', 'viewer', 'rh', 'pending'));

create or replace function public.is_rh() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'rh' from profiles where user_id = auth.uid()), false)
$$;
-- Agences d'un compte RH (vide = toutes)
create or replace function public.rh_agency_ids() returns bigint[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(agency_id), '{}') from user_agencies where user_id = auth.uid() and public.is_rh()
$$;
-- Périmètre RH complet (chauffeurs et staff) : administrateur, ou RH de l'agence (salarié sans agence compris)
create or replace function public.rh_scope(p_agency bigint) returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.is_rh() and (p_agency is null or cardinality(public.rh_agency_ids()) = 0 or p_agency = any(public.rh_agency_ids())))
$$;
create or replace function public.hr_can(p_kind text, p_agency bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select public.rh_scope(p_agency) or (p_kind = 'chauffeur' and public.my_role() = 'manager' and p_agency = any(public.my_agency_ids())
    and coalesce((select value from public.params where key = 'rhManagers'), 'oui') <> 'non')
$$;
-- Codes des chauffeurs suivis par le compte RH (présences : contrats, planning, absences, caisse)
create or replace function public.rh_driver_codes() returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(driver_code), '{}') from public.hr_employees where public.is_rh() and driver_code is not null and public.rh_scope(agency_id)
$$;
create or replace function public.rh_staff_users() returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(user_id), '{}') from public.hr_employees where public.is_rh() and user_id is not null and public.rh_scope(agency_id)
$$;
grant execute on function public.is_rh(), public.rh_agency_ids(), public.rh_scope(bigint), public.rh_driver_codes(), public.rh_staff_users() to authenticated;

-- ---------- lectures nécessaires au compte RH (rien d'autre) ----------
drop policy if exists rh_read on public.params;
create policy rh_read on public.params for select to authenticated using ((select public.is_rh()));
drop policy if exists rh_read on public.agencies;
create policy rh_read on public.agencies for select to authenticated using ((select public.is_rh()));
drop policy if exists rh_read on public.vehicles;
create policy rh_read on public.vehicles for select to authenticated using ((select public.is_rh()));
drop policy if exists rh_read on public.drivers;
create policy rh_read on public.drivers for select to authenticated using ((select public.is_rh()) and public.rh_scope(agency_id));
drop policy if exists rh_read on public.contracts;
create policy rh_read on public.contracts for select to authenticated using ((select public.is_rh()) and client_code = any((select public.rh_driver_codes())::text[]));
drop policy if exists rh_read on public.driver_plan;
create policy rh_read on public.driver_plan for select to authenticated using ((select public.is_rh()) and driver_code = any((select public.rh_driver_codes())::text[]));
drop policy if exists rh_read on public.driver_absences;
drop policy if exists rh_write on public.driver_absences;
create policy rh_read on public.driver_absences for select to authenticated using ((select public.is_rh()) and driver_code = any((select public.rh_driver_codes())::text[]));
create policy rh_write on public.driver_absences for all to authenticated using ((select public.is_rh()) and driver_code = any((select public.rh_driver_codes())::text[]))
  with check ((select public.is_rh()) and driver_code = any((select public.rh_driver_codes())::text[]));
drop policy if exists rh_read on public.cash_moves;
create policy rh_read on public.cash_moves for select to authenticated
  using ((select public.is_rh()) and kind in ('avance', 'remboursement', 'bonus') and driver_code = any((select public.rh_driver_codes())::text[]));
drop policy if exists rh_read on public.user_sessions;
create policy rh_read on public.user_sessions for select to authenticated using ((select public.is_rh()) and user_id = any((select public.rh_staff_users())::uuid[]));
-- comptes Ludy (rattacher un salarié du staff à son compte)
drop policy if exists rh_read on public.profiles;
create policy rh_read on public.profiles for select to authenticated using ((select public.is_rh()));

-- pointage : RH lit et corrige le pointage de son périmètre
drop policy if exists hr_read on public.hr_clock;
drop policy if exists hr_admin on public.hr_clock;
create policy hr_read on public.hr_clock for select to authenticated
  using ((select public.is_admin()) or user_id = auth.uid() or ((select public.is_rh()) and public.hr_can_emp(employee_id)));
create policy hr_admin on public.hr_clock for all to authenticated
  using ((select public.is_admin()) or ((select public.is_rh()) and public.hr_can_emp(employee_id)))
  with check ((select public.is_admin()) or ((select public.is_rh()) and public.hr_can_emp(employee_id)));
-- suppression : administrateur ou RH (jamais un gestionnaire)
drop policy if exists hr_delete on public.hr_employees;
create policy hr_delete on public.hr_employees for delete to authenticated using (public.rh_scope(agency_id));
drop policy if exists hr_delete on public.hr_events;
create policy hr_delete on public.hr_events for delete to authenticated using ((select public.is_admin()) or ((select public.is_rh()) and public.hr_can_emp(employee_id)));

-- sociétés employeuses : lues par les gestionnaires, gérées par l'administrateur et les RH
drop policy if exists read_mgr on public.employers;
drop policy if exists admin_all on public.employers;
create policy read_mgr on public.employers for select to authenticated using (public.my_role() in ('admin', 'manager', 'rh'));
create policy admin_all on public.employers for all to authenticated using (public.my_role() in ('admin', 'rh')) with check (public.my_role() in ('admin', 'rh'));

-- ---------- contrats de travail : RH, gestionnaire (réglage rhManagers) ; suivi signature / légalisation ----------
alter table public.work_contracts add column if not exists signed_on date;
alter table public.work_contracts add column if not exists legalized_on date;
alter table public.work_contracts add column if not exists legal_place text;
alter table public.work_contracts add column if not exists legal_path text;       -- copie signée / légalisée (stockage « contrats »)
alter table public.work_contracts add column if not exists external boolean not null default false;   -- contrat signé hors Ludy, enregistré
alter table public.work_contracts add column if not exists ended_on date;         -- remplacé (avenant, nouveau contrat) ou terminé : plus suivi
create or replace function public.wc_can(p_agency bigint) returns boolean language sql stable security definer set search_path = public as $$
  select public.rh_scope(p_agency) or (public.my_role() = 'manager' and p_agency = any(public.my_agency_ids())
    and coalesce((select value from public.params where key = 'rhManagers'), 'oui') <> 'non')
$$;
grant execute on function public.wc_can(bigint) to authenticated;
drop policy if exists read_agency on public.work_contracts;
drop policy if exists mgr_insert on public.work_contracts;
drop policy if exists mgr_update on public.work_contracts;
drop policy if exists admin_delete on public.work_contracts;
create policy read_agency on public.work_contracts for select to authenticated using (public.wc_can(agency_id));
create policy mgr_insert on public.work_contracts for insert to authenticated with check (public.wc_can(agency_id));
create policy mgr_update on public.work_contracts for update to authenticated using (public.wc_can(agency_id)) with check (public.wc_can(agency_id));
create policy admin_delete on public.work_contracts for delete to authenticated using (public.rh_scope(agency_id));

-- ---------- fiche du salarié ----------
alter table public.hr_employees add column if not exists cnss_no text;
alter table public.hr_employees add column if not exists contract_type text not null default 'CDI';
alter table public.hr_employees add column if not exists contract_end date;
alter table public.hr_employees add column if not exists category text;
alter table public.hr_employees drop constraint if exists hr_employees_contract_type_check;
alter table public.hr_employees add constraint hr_employees_contract_type_check check (contract_type in ('CDI', 'CDD', 'ANAPEC', 'Stage', 'Autre'));
alter table public.hr_employees drop constraint if exists hr_employees_category_check;
alter table public.hr_employees add constraint hr_employees_category_check check (category is null or category in ('cadre', 'employe', 'ouvrier'));

-- ---------- dossiers des salariés ----------
create table if not exists public.hr_documents (
  id bigserial primary key,
  employee_id bigint not null references public.hr_employees(id) on delete cascade,
  category text not null check (category in ('contrat', 'avenant', 'cin', 'permis', 'carte_pro', 'casier', 'cnss', 'rib', 'diplome', 'medical', 'photo', 'attestation', 'autre')),
  label text,
  path text not null,                 -- stockage « rh » : <salarié>/docs/<fichier>
  issued_on date, expires_on date,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now()
);
create index if not exists hr_documents_emp on public.hr_documents(employee_id);
alter table public.hr_documents enable row level security;
revoke all on public.hr_documents from anon, authenticated;
grant select, insert, update, delete on public.hr_documents to authenticated;
grant usage, select on sequence public.hr_documents_id_seq to authenticated;
drop policy if exists hr_read on public.hr_documents;
drop policy if exists hr_insert on public.hr_documents;
drop policy if exists hr_update on public.hr_documents;
drop policy if exists hr_delete on public.hr_documents;
create policy hr_read on public.hr_documents for select to authenticated using (public.hr_can_emp(employee_id));
create policy hr_insert on public.hr_documents for insert to authenticated with check (public.hr_can_emp(employee_id));
create policy hr_update on public.hr_documents for update to authenticated using (public.hr_can_emp(employee_id)) with check (public.hr_can_emp(employee_id));
create policy hr_delete on public.hr_documents for delete to authenticated using ((select public.is_admin()) or ((select public.is_rh()) and public.hr_can_emp(employee_id)));
drop trigger if exists hr_touch on public.hr_documents;
create trigger hr_touch before insert or update on public.hr_documents for each row execute function public.hr_touch();

-- ---------- stockage : RH dans « contrats » (dossier = agence, 0 = sans agence) et « rh » ----------
do $$ begin
  if to_regclass('storage.buckets') is not null then
    execute 'drop policy if exists contrats_insert on storage.objects';
    execute 'drop policy if exists contrats_select on storage.objects';
    execute 'drop policy if exists contrats_delete on storage.objects';
    execute $p$create policy contrats_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'contrats' and (storage.foldername(name))[1] ~ '^\d+$'
        and public.wc_can(nullif(((storage.foldername(name))[1])::bigint, 0)))$p$;
    execute $p$create policy contrats_select on storage.objects for select to authenticated
      using (bucket_id = 'contrats' and (storage.foldername(name))[1] ~ '^\d+$'
        and public.wc_can(nullif(((storage.foldername(name))[1])::bigint, 0)))$p$;
    execute $p$create policy contrats_delete on storage.objects for delete to authenticated
      using (bucket_id = 'contrats' and (storage.foldername(name))[1] ~ '^\d+$' and public.rh_scope(nullif(((storage.foldername(name))[1])::bigint, 0)))$p$;
    execute 'drop policy if exists rh_delete on storage.objects';
    execute $p$create policy rh_delete on storage.objects for delete to authenticated
      using (bucket_id = 'rh' and ((select public.is_admin()) or ((select public.is_rh()) and (storage.foldername(name))[1] ~ '^\d+$'
        and public.hr_can_emp(((storage.foldername(name))[1])::bigint))))$p$;
  end if;
end $$;

-- ---------- réglages ----------
insert into public.params (key, label, value, note, sort) values
  ('rhManagers', 'RH : les gestionnaires gèrent les chauffeurs de leurs agences (oui / non)', 'oui', 'non = ressources humaines réservées à l''administrateur et aux comptes Ressources humaines', 902),
  ('rhLegalDays', 'RH : contrat signé à légaliser (alerte après … jours)', '7', null, 903),
  ('rhSignDays', 'RH : contrat généré à faire signer (alerte après … jours)', '7', null, 904),
  ('rhDocDays', 'RH : document qui expire (alerte … jours avant)', '30', null, 905),
  ('rhContractEndDays', 'RH : fin de CDD (alerte … jours avant)', '30', null, 906),
  ('rhDocsChauffeur', 'RH : pièces obligatoires du dossier d''un chauffeur', 'cin,permis,casier,rib', 'cin, permis, carte_pro, casier, cnss, rib, diplome, medical, photo, attestation', 907),
  ('rhDocsStaff', 'RH : pièces obligatoires du dossier d''un salarié du staff', 'cin,rib', null, 908)
on conflict (key) do nothing;
