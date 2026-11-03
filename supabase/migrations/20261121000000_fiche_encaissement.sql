-- =============================================================================
-- Caisse : fiche d'encaissement du shift (03/11/2026, demande d'Ahmed : fiche imprimée pour encaisser les chauffeurs dans la rue,
-- puis déposée dans Ludy une fois l'encaissement fini). À exécuter dans Supabase > SQL Editor (après 20261120000000_santa_fe.sql).
-- Rejouable sans risque.
-- - cash_sheets : fiches remplies déposées (photo ou PDF), par agence, jour et shift ; ajoutées par l'administrateur et les
--   gestionnaires de l'agence, retirées par l'administrateur seul
-- - seau privé « caisse » : fichiers rangés par agence (<agence>/fiches/…, 0 = caisse sans agence), mêmes droits
-- =============================================================================
create table if not exists public.cash_sheets (
  id bigserial primary key,
  agency_id bigint references public.agencies(id) on delete set null,
  day date not null,
  shift text not null check (shift in ('Jour', 'Nuit')),
  path text not null,                       -- fichier dans le seau « caisse »
  file_name text, note text,
  created_by uuid default auth.uid(), created_at timestamptz not null default now()
);
create index if not exists cash_sheets_shift on public.cash_sheets(agency_id, day, shift);
alter table public.cash_sheets enable row level security;
revoke all on public.cash_sheets from anon;
revoke insert, update, delete, truncate, references, trigger on public.cash_sheets from authenticated;
grant select, insert, delete on public.cash_sheets to authenticated;
grant usage on sequence public.cash_sheets_id_seq to authenticated;
drop policy if exists sheets_read on public.cash_sheets;
drop policy if exists sheets_ins on public.cash_sheets;
drop policy if exists sheets_del on public.cash_sheets;
create policy sheets_read on public.cash_sheets for select to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[])));
create policy sheets_ins on public.cash_sheets for insert to authenticated
  with check (created_by = auth.uid() and ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any((select public.my_agency_ids())::bigint[]))));
create policy sheets_del on public.cash_sheets for delete to authenticated using ((select public.is_admin()));

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
