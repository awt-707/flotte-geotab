-- =============================================================================
-- Intégrations : identifiants de l'API Bolt Fleet saisis dans Ludy (04/11/2026, demande d'Ahmed : « dans Ludy, pas dans Apps Script »).
-- À exécuter dans Supabase > SQL Editor (après 20261122000000_justificatifs.sql). Rejouable sans risque.
-- - integration_secrets : coffre lu seulement par le collecteur (clé service) ; aucun droit pour le site (ni lecture ni écriture)
-- - integration_set(nom, valeur) : écrit ou efface une valeur, administrateur seul ; noms permis : bolt_client_id,
--   bolt_client_secret, bolt_company_id
-- - integration_status() : ce qui est enregistré (date), administrateur seul ; le secret n'est jamais renvoyé, l'identifiant client
--   et le numéro de société oui (pas secrets)
-- =============================================================================
create table if not exists public.integration_secrets (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.integration_secrets enable row level security;
revoke all on public.integration_secrets from anon, authenticated;

create or replace function public.integration_set(p_name text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_name not in ('bolt_client_id', 'bolt_client_secret', 'bolt_company_id') then raise exception 'réglage inconnu : %', p_name; end if;
  if p_value is null or btrim(p_value) = '' then delete from integration_secrets where name = p_name; return; end if;
  if p_name = 'bolt_company_id' and btrim(p_value) !~ '^\d+(\s*,\s*\d+)*$' then raise exception 'numéro de société Bolt : chiffres seulement (plusieurs séparés par des virgules)'; end if;
  insert into integration_secrets (name, value, updated_at, updated_by) values (p_name, btrim(p_value), now(), auth.uid())
    on conflict (name) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end $$;

create or replace function public.integration_status() returns table (name text, updated_at timestamptz, shown text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'réservé à l''administrateur'; end if;
  return query select s.name, s.updated_at, case when s.name = 'bolt_client_secret' then null else s.value end from integration_secrets s order by s.name;
end $$;
revoke all on function public.integration_set(text, text) from public, anon;
revoke all on function public.integration_status() from public, anon;
grant execute on function public.integration_set(text, text) to authenticated;
grant execute on function public.integration_status() to authenticated;
