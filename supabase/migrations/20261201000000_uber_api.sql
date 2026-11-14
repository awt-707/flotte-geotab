-- Intégrations : identifiants de l'API Uber (Supplier Platform, flottes) saisis dans Ludy (14/11/2026, demande d'Ahmed).
-- Même coffre que Bolt (integration_secrets, lu seulement par le collecteur) ; noms permis en plus : uber_client_id, uber_client_secret.
-- Le secret n'est jamais renvoyé au site.
create or replace function public.integration_set(p_name text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if p_name not in ('bolt_client_id', 'bolt_client_secret', 'bolt_company_id', 'uber_client_id', 'uber_client_secret') then raise exception 'réglage inconnu : %', p_name; end if;
  if p_value is null or btrim(p_value) = '' then delete from integration_secrets where name = p_name; return; end if;
  if p_name = 'bolt_company_id' and btrim(p_value) !~ '^\d+(\s*,\s*\d+)*$' then raise exception 'numéro de société Bolt : chiffres seulement (plusieurs séparés par des virgules)'; end if;
  insert into integration_secrets (name, value, updated_at, updated_by) values (p_name, btrim(p_value), now(), auth.uid())
    on conflict (name) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end $$;

create or replace function public.integration_status() returns table (name text, updated_at timestamptz, shown text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'réservé à l''administrateur'; end if;
  return query select s.name, s.updated_at, case when s.name like '%secret%' then null else s.value end from integration_secrets s order by s.name;
end $$;
revoke all on function public.integration_set(text, text) from public, anon;
revoke all on function public.integration_status() from public, anon;
grant execute on function public.integration_set(text, text) to authenticated;
grant execute on function public.integration_status() to authenticated;
