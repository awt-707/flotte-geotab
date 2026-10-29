-- =============================================================================
-- Courses privées : une grille tarifaire par ville de départ (29/10/2026, demande d'Ahmed : grille au départ de Marrakech
-- pour l'agence de Marrakech, même logique prix / distance que la grille de Casablanca).
-- À exécuter dans Supabase > SQL Editor (après 20261116000000_menu.sql). Rejouable sans risque.
-- - pricing_grid : plusieurs lignes (id 1 = Casablanca, inchangée), nom de la ville de départ, agence (option : grille proposée
--   par défaut aux courses de cette agence) ; data.origin (ville de départ des intervilles), data.airportName (aéroport des transferts)
-- - grille Marrakech créée une fois, copie de la grille de Casablanca (mise à disposition, suppléments, conditions identiques)
--   avec ses transferts aéroport Marrakech-Menara et ses intervilles depuis Marrakech :
--   prix = part fixe + prix au km, tirés de la grille de Casablanca par régression sur les km routiers réels (OpenStreetMap,
--   OSRM) de ses trajets (écart ≤ 6 % sur la grille de Casablanca) : transferts aéroport 176 MAD + 7,55 MAD/km (Sonata),
--   312 MAD + 10,86 MAD/km (Staria) ; intervilles 93 MAD + 7,19 MAD/km (Sonata), 191 MAD + 10,52 MAD/km (Staria) ; arrondi à 10 MAD.
--   Même trajet que la grille de Casablanca (Marrakech ↔ Casablanca, Marrakech ↔ aéroport Mohammed V) = même prix ;
--   en ville = forfait de la grille de Casablanca. Prix modifiables par l'administrateur (Courses privées > Grille tarifaire).
-- =============================================================================
alter table public.pricing_grid drop constraint if exists pricing_grid_id_check;
alter table public.pricing_grid add column if not exists name text;
-- agence sans clé étrangère : la grille ne doit jamais partir avec un « truncate agencies cascade » (agence retirée = grille gardée)
alter table public.pricing_grid add column if not exists agency_id bigint;
create sequence if not exists public.pricing_grid_id_seq owned by public.pricing_grid.id;
alter table public.pricing_grid alter column id set default nextval('public.pricing_grid_id_seq');
create unique index if not exists pricing_grid_name on public.pricing_grid (lower(name));

update public.pricing_grid set name = coalesce(name, 'Casablanca'),
  data = data || jsonb_build_object('origin', coalesce(data->>'origin', 'Casablanca'), 'airportName', coalesce(data->>'airportName', 'Mohammed V'))
  where id = 1;

insert into public.pricing_grid (id, name, data)
select 2, 'Marrakech', g.data || $m${
  "origin": "Marrakech", "airportName": "Marrakech-Menara",
  "airport": [
    { "dest": "Marrakech", "SONATA": 320, "STARIA": 570 },
    { "dest": "Casablanca", "SONATA": 2030, "STARIA": 2970 },
    { "dest": "Rabat", "SONATA": 2630, "STARIA": 3840 },
    { "dest": "Essaouira", "SONATA": 1570, "STARIA": 2320 },
    { "dest": "Agadir", "SONATA": 2070, "STARIA": 3030 },
    { "dest": "Ouarzazate", "SONATA": 1680, "STARIA": 2480 },
    { "dest": "El Jadida", "SONATA": 1690, "STARIA": 2480 },
    { "dest": "Fès", "SONATA": 4200, "STARIA": 6090 },
    { "dest": "Tanger", "SONATA": 4510, "STARIA": 6540 },
    { "dest": "Tétouan", "SONATA": 4900, "STARIA": 7100 }],
  "intercity": [
    { "dest": "En ville (Marrakech)", "SONATA": 150, "STARIA": 200 },
    { "dest": "Casablanca", "SONATA": 1720, "STARIA": 2720 },
    { "dest": "Aéroport Mohammed V", "SONATA": 1950, "STARIA": 2830 },
    { "dest": "Rabat", "SONATA": 2380, "STARIA": 3540 },
    { "dest": "Essaouira", "SONATA": 1440, "STARIA": 2150 },
    { "dest": "Agadir", "SONATA": 1910, "STARIA": 2840 },
    { "dest": "Ouarzazate", "SONATA": 1480, "STARIA": 2220 },
    { "dest": "El Jadida", "SONATA": 1530, "STARIA": 2290 },
    { "dest": "Fès", "SONATA": 3880, "STARIA": 5720 },
    { "dest": "Tanger", "SONATA": 4170, "STARIA": 6150 },
    { "dest": "Tétouan", "SONATA": 4540, "STARIA": 6700 }],
  "calc": "Prix au départ de Marrakech calculés le 29/10/2026 avec la logique de la grille de Casablanca : part fixe + prix au km (km routiers OpenStreetMap ; transferts aéroport 176 MAD + 7,55 MAD/km Sonata, 312 MAD + 10,86 MAD/km Staria ; intervilles 93 MAD + 7,19 MAD/km Sonata, 191 MAD + 10,52 MAD/km Staria ; arrondi à 10 MAD). Même trajet que la grille de Casablanca = même prix ; en ville = forfait de Casablanca."
}$m$::jsonb
from public.pricing_grid g
where g.id = 1 and not exists (select 1 from public.pricing_grid where id = 2 or lower(name) = 'marrakech');
select setval('public.pricing_grid_id_seq', greatest((select max(id) from public.pricing_grid), 2));

-- l'administrateur crée, renomme, rattache à une agence et retire une grille (règle admin_all) ; les gestionnaires lisent
grant insert (name, agency_id, data) on public.pricing_grid to authenticated;
grant update (name, agency_id, data, updated_at, updated_by) on public.pricing_grid to authenticated;
grant delete on public.pricing_grid to authenticated;
grant usage on sequence public.pricing_grid_id_seq to authenticated;
-- la grille de Casablanca (id 1) n'est jamais retirée (seuil de validation des devis lu dans la base)
drop policy if exists keep_main on public.pricing_grid;
create policy keep_main on public.pricing_grid as restrictive for delete to authenticated using (id <> 1);
