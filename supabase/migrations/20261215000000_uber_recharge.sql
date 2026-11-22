-- =============================================================================
-- Rechargement périodique de la page Uber Fleet lue par l'application Ludy (22/11/2026, demande d'Ahmed : la carte en arrière-plan
-- prend du retard sur Uber Fleet dans un navigateur, d'où de fausses alertes). Réglable dans Réglages (minutes, 1 par défaut).
-- À exécuter dans Supabase > SQL Editor après 20261214000000_courses_suspectes.sql. Rejouable.
-- =============================================================================
insert into public.params (key, label, value, note, sort) values
  ('uberReloadMin', 'Uber Fleet : page rechargée toutes les (min)', '1', 'Application Ludy (robot) : la page Uber Fleet lue en arrière-plan est rechargée à cet intervalle pour rester à jour (jamais pendant qu''elle est affichée). 0,5 au moins.', 143)
on conflict (key) do update set label = excluded.label, note = excluded.note, sort = excluded.sort;
