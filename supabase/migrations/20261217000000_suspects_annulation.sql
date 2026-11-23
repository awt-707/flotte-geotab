-- =============================================================================
-- Courses suspectes : alerte seulement avec une annulation Uber (23/11/2026, demande d'Ahmed : le vrai scénario = le client annule,
-- le chauffeur le prend en cachette). Le collecteur note l'annulation Uber (client / chauffeur) qui chevauche la période ; le site ne
-- lève l'alerte rouge « a roulé » que si une annulation la corrobore. Les cas sans annulation restent dans le tableau, sans notification.
-- À exécuter dans Supabase > SQL Editor après 20261216000000_suspects_courses.sql. Rejouable.
-- =============================================================================
alter table public.uber_suspects add column if not exists cx_status text;
alter table public.uber_suspects drop constraint if exists uber_suspects_cx_status_check;
alter table public.uber_suspects add constraint uber_suspects_cx_status_check
  check (cx_status is null or cx_status in ('client', 'chauffeur'));
