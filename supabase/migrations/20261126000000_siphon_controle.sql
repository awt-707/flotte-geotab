-- =============================================================================
-- Contrôle des siphonages suspects (13/11/2026, demande d'Ahmed : « je veux l'info la plus fiable possible »).
-- À exécuter dans Supabase > SQL Editor (après 20261125000000_promos.sql). Rejouable sans risque.
-- fuel.check_note : verdict du collecteur pour un siphonage suspect (véhicule déplacé pendant l'arrêt d'après le GPS Geotab,
-- jauge remontée après le redémarrage, ou véhicule immobile et jauge restée basse = à vérifier). Écrit par le collecteur seul.
-- =============================================================================
alter table public.fuel add column if not exists check_note text;
