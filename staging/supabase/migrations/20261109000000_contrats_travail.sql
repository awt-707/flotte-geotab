-- =============================================================================
-- Contrats de travail (23/10/2026, demande d'Ahmed). À exécuter dans Supabase > SQL Editor
-- (après 20261108000000_planning_pdf.sql). Rejouable sans risque.
-- - employers : sociétés employeuses (nom, forme, capital, siège, RC, dirigeant, contact RH, ville de signature ;
--   français et arabe) : plusieurs sociétés possibles ; lues par les gestionnaires, modifiées par l'administrateur
-- - work_contracts : contrats générés (champs saisis, société au moment du contrat, PDF dans le stockage « contrats »)
--   administrateur : tout ; gestionnaire : contrats des agences auxquelles il est rattaché (agence obligatoire)
-- - stockage privé « contrats » : <agence>/<contrat>_….pdf (0 = sans agence, administrateur seulement)
-- =============================================================================
create table if not exists public.employers (
  id bigserial primary key,
  name text not null,
  data jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.work_contracts (
  id bigserial primary key,
  employer_id bigint references public.employers(id),
  agency_id bigint references public.agencies(id),
  driver_code text,
  name text,
  cin text,
  effective_on date,
  data jsonb not null default '{}'::jsonb,
  pdf_path text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists work_contracts_created on public.work_contracts(created_at desc);

alter table public.employers enable row level security;
alter table public.work_contracts enable row level security;
revoke all on public.employers, public.work_contracts from anon, authenticated;
grant select, insert, update, delete on public.employers, public.work_contracts to authenticated;
grant usage, select on sequence public.employers_id_seq, public.work_contracts_id_seq to authenticated;

drop policy if exists read_mgr on public.employers;
drop policy if exists admin_all on public.employers;
create policy read_mgr on public.employers for select to authenticated using (public.my_role() in ('admin', 'manager'));
create policy admin_all on public.employers for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists read_agency on public.work_contracts;
drop policy if exists mgr_insert on public.work_contracts;
drop policy if exists mgr_update on public.work_contracts;
drop policy if exists admin_delete on public.work_contracts;
create policy read_agency on public.work_contracts for select to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any(public.my_agency_ids())));
create policy mgr_insert on public.work_contracts for insert to authenticated
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any(public.my_agency_ids())));
create policy mgr_update on public.work_contracts for update to authenticated
  using ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any(public.my_agency_ids())))
  with check ((select public.is_admin()) or (public.my_role() = 'manager' and agency_id = any(public.my_agency_ids())));
create policy admin_delete on public.work_contracts for delete to authenticated using ((select public.is_admin()));

-- auteur = utilisateur connecté (jamais modifiable), date de mise à jour
create or replace function public.work_contracts_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.created_by := auth.uid(); new.created_at := now();
  else new.created_by := old.created_by; new.created_at := old.created_at; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists work_contracts_guard on public.work_contracts;
create trigger work_contracts_guard before insert or update on public.work_contracts for each row execute function public.work_contracts_guard();
create or replace function public.employers_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists employers_touch on public.employers;
create trigger employers_touch before update on public.employers for each row execute function public.employers_touch();

do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('contrats', 'contrats', false) on conflict (id) do nothing;
    execute 'drop policy if exists contrats_insert on storage.objects';
    execute 'drop policy if exists contrats_select on storage.objects';
    execute 'drop policy if exists contrats_delete on storage.objects';
    execute $p$create policy contrats_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'contrats' and ((select public.is_admin()) or (public.my_role() = 'manager'
        and (storage.foldername(name))[1] ~ '^\d+$' and ((storage.foldername(name))[1])::bigint = any(public.my_agency_ids()))))$p$;
    execute $p$create policy contrats_select on storage.objects for select to authenticated
      using (bucket_id = 'contrats' and ((select public.is_admin()) or (public.my_role() = 'manager'
        and (storage.foldername(name))[1] ~ '^\d+$' and ((storage.foldername(name))[1])::bigint = any(public.my_agency_ids()))))$p$;
    execute $p$create policy contrats_delete on storage.objects for delete to authenticated using (bucket_id = 'contrats' and (select public.is_admin()))$p$;
  end if;
end $$;
