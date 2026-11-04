-- =============================================================================
-- Seuil d'alerte de dépassement de vitesse par limite de route (16/10/2026).
-- trips.over_by_limit : plus gros dépassement mesuré sur chaque limite de route du trajet ({ limite: [dépassement, vitesse, instant] }),
-- calculé par le collecteur (19_speed.gs) ; les alertes se recalculent avec les seuils de Réglages sans retélécharger.
-- À exécuter dans Supabase > SQL Editor. Rejouable sans risque.
-- =============================================================================
alter table public.trips add column if not exists over_by_limit text;
insert into public.params (key, label, value, note, sort)
values ('overByLimit', 'Dépassement : seuil d''alerte par limite de route', '',
  'limite:seuil séparés par « ; » (ex. 50:30;80:20;120:20). Limite non listée : la ligne inférieure la plus proche, sinon le seuil général. Réglé dans Réglages > Alerte de dépassement de vitesse', 60)
on conflict (key) do nothing;
