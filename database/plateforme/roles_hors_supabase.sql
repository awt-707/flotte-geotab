-- =============================================================================
-- PostgreSQL sans Supabase (ex. PostgreSQL géré par OVH + PostgREST + service de connexion) : ce que Supabase fournit d'office
-- et dont le schéma de Ludy a besoin. À exécuter une fois, AVANT database/schema/. Rien à faire sur Supabase (auto-hébergé ou non).
--   - rôles anon / authenticated / service_role (droits du site et du collecteur), authenticator (connexion de PostgREST) ;
--   - auth.uid() : identifiant de l'utilisateur lu dans le jeton (JWT) transmis par PostgREST ;
--   - auth.users : comptes (le service de connexion GoTrue la crée lui-même s'il est installé : alors seulement les rôles).
-- Le mot de passe d'authenticator se pose à part (jamais dans le dépôt) : alter role authenticator password '…';
-- =============================================================================
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create table if not exists auth.users (id uuid primary key, email text, created_at timestamptz default now());
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;
