-- =============================================================================
-- Caisse : copie de sauvegarde dans Google Sheets (22/10/2026, demande d'Ahmed). À exécuter après 20261103000000_caisse.sql.
-- - uber_payments : prénom, nom et ligne complète de l'export Uber (raw : cellules non vides, par en-tête) pour recopier
--   l'onglet « Export Uber - Opérations de paiement Ludy » à l'identique
-- - cashSheetId : classeur où le collecteur recopie la caisse (onglets « … Ludy ») à chaque passage
-- =============================================================================
alter table public.uber_payments add column if not exists first_name text;
alter table public.uber_payments add column if not exists last_name text;
alter table public.uber_payments add column if not exists raw jsonb;

insert into public.params (key, label, value, note, sort) values
  ('cashSheetId', 'Caisse : classeur de sauvegarde (ID Google Sheets)', '10Bj3dP-JGHZrS4HxN_fMTIyoZYVj_LSWVb9Ngup0FPg',
   'Chaque saisie de la Caisse est recopiée dans ce classeur (onglets « … Ludy », format du classeur Suivi Cash Chauffeurs) à chaque passage du collecteur (5 min). Vide = pas de copie.', 121)
on conflict (key) do nothing;
