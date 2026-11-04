-- =============================================================================
-- Volets externes de l'application Ludy (17/10/2026). À exécuter une fois dans Supabase > SQL Editor (après 20261024000000_carte_carburant.sql).
-- Liste des sites affichés dans l'application Mac / Windows, à droite du menu Ludy (Uber Fleet, Clicar…), modifiable dans
-- Réglages > Volets externes : ajouter un site ne demande pas de nouvelle application. Rejouable sans risque.
-- =============================================================================
insert into public.params (key, label, value, note, sort)
values ('appSites', 'Volets externes de l''application',
  '[{"id":"uber","name":"Uber Fleet","url":"https://fleethub.uber.com/orgs/692d0268-9766-4061-9c0e-85d7c124d10e/livemap?tab=4"},{"id":"clicar","name":"Clicar","url":"https://new.clicar.ma/"}]',
  'JSON [{id, name, url}] ; réglé dans Réglages > Volets externes', 90)
on conflict (key) do nothing;

-- Volets visibles par utilisateur (Réglages > Utilisateurs) : liste des volets du menu, vide (null) = tous.
-- Choisie par l'administrateur ; le menu ne montre que ces volets, les données restent limitées par agence.
alter table public.profiles add column if not exists pages text[];
grant update (role, name, pages) on public.profiles to authenticated;
