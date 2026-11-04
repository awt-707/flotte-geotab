-- =============================================================================
-- Caisse : justificatifs des dépenses et preuves de dépôt en banque (04/11/2026, demande d'Ahmed).
-- À exécuter dans Supabase > SQL Editor (après 20261121000000_fiche_encaissement.sql). Rejouable sans risque.
-- - cash_files : fichiers joints (photo ou PDF) : justificatif d'une dépense (kind 'justif', move_id = la dépense, category =
--   catégorie de la dépense) ou reçu de la banque d'un dépôt (kind 'depot', dep_ref = bordereau DEP-…). Copiés ensuite par le
--   collecteur dans le Google Drive de l'agence (« Justificatifs agence … » avec un sous-dossier par catégorie,
--   « Dépôts banque agence … ») : drive_id rempli par le collecteur (clé service) seulement.
-- - droits : administrateur et gestionnaires de l'agence ajoutent et lisent ; administrateur retire
-- - seau privé « caisse » (repris de 20261121 si elle n'a pas été exécutée) : <agence>/justificatifs/…, <agence>/depots/…
-- =============================================================================
create table if not exists public.cash_files (
  id bigserial primary key,
  agency_id bigint references public.agencies(id) on delete set null,
  kind text not null check (kind in ('justif', 'depot')),
  move_id bigint references public.cash_moves(id) on delete set null,   -- dépense justifiée
  dep_ref text,                                                         -- bordereau de dépôt (DEP-…)
  day date,                                                             -- jour de la dépense / du dépôt
  category text,                                                        -- catégorie de la dépense (sous-dossier du Drive)
  title text,                                                           -- nom du fichier dans le Drive (sans extension)
  path text not null,                                                   -- fichier dans le seau « caisse »
  file_name text,                                                       -- nom du fichier déposé
  drive_id text, drive_error text, drive_at timestamptz,                -- copie dans le Google Drive (collecteur)
  created_by uuid default auth.uid(), created_at timestamptz not null default now(),
  check ((kind = 'justif' and move_id is not null) or (kind = 'depot' and dep_ref is not null))
);
create index if not exists cash_files_move on public.cash_files(move_id) where move_id is not null;
create index if not exists cash_files_ref on public.cash_files(agency_id, dep_ref) where dep_ref is not null;
create index if not exists cash_files_drive on public.cash_files(id) where drive_id is null;
alter table public.cash_files enable row level security;
revoke all on public.cash_files from anon;
revoke insert, update, delete, truncate, references, trigger on public.cash_files from authenticated;
grant select, insert, delete on public.cash_files to authenticated;
grant usage on sequence public.cash_files_id_seq to authenticated;
drop policy if exists files_read on public.cash_files;
drop policy if exists files_ins on public.cash_files;
drop policy if exists files_del on public.cash_files;
create policy files_read on public.cash_files for select to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[])));
-- la dépense justifiée doit être de la même agence (et visible par l'auteur)
create policy files_ins on public.cash_files for insert to authenticated
  with check (created_by = auth.uid() and drive_id is null
    and ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[])))
    and (move_id is null or exists (select 1 from public.cash_moves m where m.id = move_id and m.agency_id is not distinct from cash_files.agency_id)));
create policy files_del on public.cash_files for delete to authenticated using ((select public.is_admin()));

-- dossier du seau = agence (0 = caisse sans agence : administrateur, ou gestionnaire quand aucune agence n'existe)
create or replace function public.cash_folder_ok(f text) returns boolean language sql stable security definer set search_path = public as $$
  select f ~ '^\d+$' and (public.is_admin() or (public.my_role() = 'manager' and (
    (f <> '0' and f::bigint = any(public.my_agency_ids()::bigint[])) or (f = '0' and not exists (select 1 from agencies)))))
$$;
grant execute on function public.cash_folder_ok(text) to authenticated;
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('caisse', 'caisse', false) on conflict (id) do nothing;
    execute 'drop policy if exists caisse_insert on storage.objects';
    execute 'drop policy if exists caisse_select on storage.objects';
    execute $p$create policy caisse_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'caisse' and public.cash_folder_ok((storage.foldername(name))[1]))$p$;
    execute $p$create policy caisse_select on storage.objects for select to authenticated
      using (bucket_id = 'caisse' and public.cash_folder_ok((storage.foldername(name))[1]))$p$;
  end if;
end $$;

-- dossiers Google Drive créés par le collecteur (liens affichés dans la Caisse)
insert into public.params (key, label, value, note, sort) values ('cashDrive', 'Dossiers Google Drive de la caisse (créés par le collecteur)', '{}', 'Ne pas modifier', 996)
  on conflict (key) do nothing;
