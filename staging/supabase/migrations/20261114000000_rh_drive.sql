-- =============================================================================
-- Ressources humaines : copie dans Google Drive (25/10/2026, demande d'Ahmed).
-- À exécuter dans Supabase > SQL Editor (après 20261113000000_relecture2.sql). Rejouable sans risque.
-- - agencies.rh_drive : dossiers Drive de l'agence { contracts, payroll, clock } (lien du dossier ou identifiant)
-- - params rhDriveContracts / rhDrivePayroll / rhDriveClock : dossiers par défaut (agence sans dossier, salarié sans agence)
-- - work_contracts.drive_pdf_id / drive_legal_id, hr_events.drive_doc_id : fichier déjà copié dans le Drive
--   (remis à zéro quand le fichier change : la nouvelle version est copiée au passage suivant du collecteur)
-- - rh_drive_set(agence, dossiers) : réglage par l'administrateur ou un compte Ressources humaines (agence null = défaut)
-- =============================================================================
alter table public.agencies add column if not exists rh_drive jsonb not null default '{}'::jsonb;
alter table public.work_contracts add column if not exists drive_pdf_id text;
alter table public.work_contracts add column if not exists drive_legal_id text;
alter table public.hr_events add column if not exists drive_doc_id text;

insert into public.params (key, label, value, note, sort) values
  ('rhDriveContracts', 'RH : dossier Drive des contrats (par défaut)', '', 'Lien du dossier Google Drive : contrats générés, copies signées / légalisées et avenants signés (agences sans dossier propre)', 911),
  ('rhDrivePayroll', 'RH : dossier Drive de la paie (par défaut)', '', 'Lien du dossier Google Drive : état mensuel (éléments variables de paie), un classeur par mois', 912),
  ('rhDriveClock', 'RH : dossier Drive du pointage et des absences (par défaut)', '', 'Lien du dossier Google Drive : pointage du staff, absences et congés, présence des chauffeurs, un classeur par mois', 913)
on conflict (key) do nothing;

-- fichier remplacé : nouvelle copie dans le Drive
create or replace function public.rh_drive_reset() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'work_contracts' then
    if new.pdf_path is distinct from old.pdf_path then new.drive_pdf_id := null; end if;
    if new.legal_path is distinct from old.legal_path then new.drive_legal_id := null; end if;
  elsif new.doc_path is distinct from old.doc_path then new.drive_doc_id := null;
  end if;
  return new;
end $$;
drop trigger if exists work_contracts_drive_reset on public.work_contracts;
create trigger work_contracts_drive_reset before update on public.work_contracts for each row execute function public.rh_drive_reset();
drop trigger if exists hr_events_drive_reset on public.hr_events;
create trigger hr_events_drive_reset before update on public.hr_events for each row execute function public.rh_drive_reset();

-- dossiers Drive d'une agence (null = dossiers par défaut) : identifiants seulement, champs connus seulement
create or replace function public.rh_drive_set(p_agency bigint, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text; v text; d jsonb := '{}'::jsonb; pk text;
begin
  if not (public.is_admin() or (public.is_rh() and public.rh_scope(p_agency) and (p_agency is not null or cardinality(public.rh_agency_ids()) = 0))) then
    raise exception 'Réservé à l''administrateur et aux comptes Ressources humaines de l''agence';
  end if;
  foreach k in array array['contracts', 'payroll', 'clock'] loop
    v := coalesce(substring(coalesce(p_data ->> k, '') from '[-_A-Za-z0-9]{20,}'), '');
    if p_agency is null then
      pk := case k when 'contracts' then 'rhDriveContracts' when 'payroll' then 'rhDrivePayroll' else 'rhDriveClock' end;
      insert into params (key, value) values (pk, v) on conflict (key) do update set value = excluded.value;
    elsif v <> '' then d := d || jsonb_build_object(k, v);
    end if;
  end loop;
  if p_agency is not null then
    update agencies set rh_drive = d where id = p_agency;
    if not found then raise exception 'Agence inconnue'; end if;
  end if;
  return d;
end $$;
revoke all on function public.rh_drive_set(bigint, jsonb) from public, anon;
grant execute on function public.rh_drive_set(bigint, jsonb) to authenticated;
