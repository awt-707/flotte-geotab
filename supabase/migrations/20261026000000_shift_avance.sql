-- =============================================================================
-- Shift d'un contrat : avance réglable (17/10/2026). À exécuter une fois dans Supabase > SQL Editor. Rejouable sans risque.
-- Un contrat pris jusqu'à N heures avant le début d'un shift compte dans ce shift (2 : pris de 05:00 à 16:59 = jour,
-- de 17:00 à 04:59 = nuit). Modifiable dans Réglages > Paramètres. Sans cette ligne, le site et le collecteur prennent 2 h.
-- =============================================================================
insert into public.params (key, label, value, note, sort)
values ('shiftAdvance', 'Shift d''un contrat : avance (heures)', '2',
  'Contrat pris jusqu''à N h avant le début d''un shift : compté dans ce shift (2 : pris de 05:00 à 16:59 = jour, de 17:00 à 04:59 = nuit ; 0 : 07:00 → 18:59 jour)', 41)
on conflict (key) do nothing;
