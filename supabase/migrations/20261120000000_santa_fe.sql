-- =============================================================================
-- Courses privées : catégorie Hyundai Santa Fe (03/11/2026, demande d'Ahmed : « 4x4 Luxe », 6 passagers, même tarif que le Staria)
-- À exécuter dans Supabase > SQL Editor (après 20261119000000_bolt.sql). Rejouable sans risque.
-- Dans chaque grille (Casablanca, Marrakech…) qui n'a pas encore de Santa Fe : catégorie SANTAFE ajoutée et chaque prix du Staria
-- recopié pour le Santa Fe (mise à disposition, km et heures en plus, attente, transferts aéroport, intervilles).
-- Prix ensuite modifiables séparément par l'administrateur (Courses privées > Grille tarifaire).
-- =============================================================================
update public.pricing_grid g set data = g.data
  || jsonb_build_object('cats', coalesce(g.data->'cats', '[]'::jsonb)
       || '[{ "id": "SANTAFE", "label": "4x4 Luxe — 6 passagers", "model": "Hyundai Santa Fe", "seats": 6 }]'::jsonb)
  || (select coalesce(jsonb_object_agg(k, g.data->k || jsonb_build_object('SANTAFE', g.data->k->'STARIA')), '{}'::jsonb)
        from unnest(array['hourly', 'half', 'day', 'kmExtra', 'wait15']) k
       where jsonb_typeof(g.data->k) = 'object' and g.data->k ? 'STARIA')
  || (select coalesce(jsonb_object_agg(k, (select coalesce(jsonb_agg(case when r ? 'STARIA' then r || jsonb_build_object('SANTAFE', r->'STARIA') else r end order by n), '[]'::jsonb)
                                            from jsonb_array_elements(g.data->k) with ordinality as a(r, n))), '{}'::jsonb)
        from unnest(array['airport', 'intercity']) k
       where jsonb_typeof(g.data->k) = 'array')
 where not exists (select 1 from jsonb_array_elements(coalesce(g.data->'cats', '[]'::jsonb)) c where c->>'id' = 'SANTAFE');
