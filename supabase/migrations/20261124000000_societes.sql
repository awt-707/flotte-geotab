-- =============================================================================
-- Plusieurs sociétés pour les manifestes et les devis (10/11/2026, demande d'Ahmed : société EL PUENTE TRAVEL à côté de
-- LUXURY & DISCOVERY, plaques attribuées à l'une ou à l'autre). À exécuter dans Supabase > SQL Editor (après
-- 20261123000000_integrations.sql). Rejouable sans risque.
-- - manifest_config : une ligne par société (dénomination, adresse, téléphone, N° d'autorisation, N° de dossier, cachet,
--   destinataires e-mail) ; la ligne 1 reste la société principale (LUXURY & DISCOVERY), utilisée par défaut
-- - parc.company_id : société d'une plaque (vide = société principale) ; manifestes et devis prennent la société du véhicule
-- Droits inchangés : administrateur = modifie ; gestionnaires = lisent.
-- =============================================================================
alter table public.manifest_config drop constraint if exists manifest_config_id_check;
alter table public.manifest_config add column if not exists active boolean not null default true;
create sequence if not exists public.manifest_config_id_seq owned by public.manifest_config.id;
select setval('public.manifest_config_id_seq', greatest(1, (select coalesce(max(id), 1) from public.manifest_config)));
alter table public.manifest_config alter column id set default nextval('public.manifest_config_id_seq');
grant usage, select on sequence public.manifest_config_id_seq to authenticated;
grant delete on public.manifest_config to authenticated;   -- administrateur seul (politique admin_all)

-- ligne 1 jamais retirée (société principale)
create or replace function public.manifest_config_keep() returns trigger language plpgsql as $$
begin
  if old.id = 1 then raise exception 'société principale : ne peut pas être retirée'; end if;
  return old;
end $$;
drop trigger if exists manifest_config_keep on public.manifest_config;
create trigger manifest_config_keep before delete on public.manifest_config for each row execute function public.manifest_config_keep();

alter table public.parc add column if not exists company_id integer references public.manifest_config(id) on delete set null;

-- EL PUENTE TRAVEL (cachet : coordonnées imprimées dessus) ; téléphone, N° d'autorisation et N° de dossier à compléter
-- dans Manifestes > Réglages (rien d'inventé)
insert into public.manifest_config (company)
select jsonb_build_object('nom', 'EL PUENTE TRAVEL SARL', 'adresse', '5, Bd Abdellah Ben Yassine, Imm Belledone Etg 5 N° 5, Casablanca',
  'tel', '', 'autorisation', '', 'dossier', '')
where not exists (select 1 from public.manifest_config where upper(company->>'nom') like 'EL PUENTE%');
