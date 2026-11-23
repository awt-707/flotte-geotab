-- =============================================================================
-- Courses suspectes : moins de faux positifs (23/11/2026, signalé par Ahmed : trop de notifications « course sans Uber »).
-- Beaucoup de cas sont de vraies courses Uber où la lecture en direct a raté l'état « Course en cours » (trou au rechargement de la page,
-- course courte) : le rapport Uber (uber_trips) les montre « completed ». Le collecteur croise désormais avec uber_trips : une course
-- réalisée pendant la période = verdict « course réalisée » (jamais d'alerte). Nouveau verdict ajouté au contrôle.
-- À exécuter dans Supabase > SQL Editor après 20261215000000_uber_recharge.sql. Rejouable.
-- =============================================================================
alter table public.uber_suspects drop constraint if exists uber_suspects_verdict_check;
alter table public.uber_suspects add constraint uber_suspects_verdict_check
  check (verdict is null or verdict in ('roulé', 'sur place', 'non mesuré', 'course réalisée'));
