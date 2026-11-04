-- =============================================================================
-- Menu personnalisé (29/10/2026, demande d'Ahmed : retrouver ses pages sans chercher).
-- À exécuter dans Supabase > SQL Editor (après 20261115000000_contrat_staff.sql). Rejouable sans risque.
-- - profiles.menu : réglage du menu de l'utilisateur { fav, order, hide } (favoris, ordre des volets, volets masqués)
-- - menu_set(menu) : chacun enregistre seulement son propre menu (pas de droit d'écriture sur les profils)
-- =============================================================================
alter table public.profiles add column if not exists menu jsonb;

create or replace function public.menu_set(p_menu jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_menu is not null and (jsonb_typeof(p_menu) <> 'object' or length(p_menu::text) > 16000) then raise exception 'Réglage du menu invalide'; end if;
  update profiles set menu = p_menu where user_id = auth.uid();
end $$;
revoke all on function public.menu_set(jsonb) from public, anon;
grant execute on function public.menu_set(jsonb) to authenticated;
