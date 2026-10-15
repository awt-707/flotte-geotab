-- Relais Geotab en direct (fonction Supabase « geotab-live ») : session Geotab partagée entre les appels,
-- lisible et modifiable uniquement par la fonction (clé service_role). À exécuter une fois dans Supabase > SQL Editor.
create table if not exists public.geotab_session (
  id integer primary key default 1 check (id = 1), server text, credentials jsonb, updated_at timestamptz default now()
);
alter table public.geotab_session enable row level security;
revoke all on public.geotab_session from anon, authenticated;
grant all on public.geotab_session to service_role;
