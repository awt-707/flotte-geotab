-- Versions du collecteur publiées par GitHub Actions (seulement après tests réussis).
-- Le collecteur Apps Script lit la dernière version et met à jour son propre code (API Apps Script).
create table if not exists public.releases (
  id bigint generated always as identity primary key,
  version text not null,                 -- ex. 2026-10-15.3f2a1bc
  sha text not null unique,              -- commit Git
  files jsonb not null,                  -- [{ name, type: SERVER_JS | JSON, source }]
  created_at timestamptz not null default now()
);
alter table public.releases enable row level security;
revoke all on public.releases from anon, authenticated;
grant select, insert on public.releases to service_role;
-- Les administrateurs voient les versions publiées (sans le code) depuis le site
grant select (id, version, sha, created_at) on public.releases to authenticated;
drop policy if exists read_admin on public.releases;
create policy read_admin on public.releases for select to authenticated using (public.my_role() = 'admin');
