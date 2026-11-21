-- Comparaison du shift avec la veille au même moment (21/11/2026, demande d'Ahmed : « total shift de tous les chauffeurs, comparé à J-1
-- au même moment, avec le total J-1 et le pourcentage de dépassement ou de manque »).
-- uber_perf : période « cmp:<jour>:<Jour|Nuit> » = chiffres d'Uber de la veille, du début du même shift jusqu'à la même heure
-- (data.to = fin de la période d'hier, en ms), une ligne par chauffeur, réécrite toutes les 2 min environ avec la période du jour.

create or replace function public.uber_perf_push(p_period text, p_from timestamptz, p_items jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_role text := coalesce((select role from profiles where user_id = auth.uid()), ''); it jsonb; k text; d text; v_key text; v_ag bigint; v_plate text; n integer := 0;
begin
  if auth.uid() is null or v_role not in ('admin', 'manager', 'viewer') then raise exception 'Envoi refusé'; end if;
  if coalesce(p_period, '') !~ '^(shift|cmp):\d{4}-\d{2}-\d{2}:(Jour|Nuit)$' then raise exception 'Période invalide'; end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 200 then raise exception 'Envoi invalide'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    d := lower(coalesce(it->>'d', ''));
    if d !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then continue; end if;
    -- véhicule de Ludy : plaque lue dans Uber Fleet (chiffres puis lettres) ; plaque écrite sans lettres = seul véhicule aux mêmes chiffres
    v_plate := nullif(left(it->>'p', 30), ''); k := norm_plate(v_plate); v_key := null; v_ag := null;
    if length(k) >= 4 then
      select v.key, v.agency_id into v_key, v_ag from vehicles v where norm_plate(v.plate) = k or norm_plate(v.key) = k limit 1;
      if v_key is null and k ~ '^\d{5,6}$' and (select count(*) from vehicles v where regexp_replace(v.plate, '\D', '', 'g') = k) = 1 then
        select v.key, v.agency_id, v.plate into v_key, v_ag, v_plate from vehicles v where regexp_replace(v.plate, '\D', '', 'g') = k;
      end if;
    end if;
    insert into uber_perf (driver_id, period, period_from, driver_name, plate, vehicle_key, agency_id, data, updated_at)
      values (d, p_period, p_from, nullif(left(it->>'n', 80), ''), v_plate, v_key, v_ag,
        coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(it) e
          where e.key in ('e', 'cash', 'h', 't', 'a', 'c', 'hot', 'hto', 'hav', 'first', 'last', 'to') and jsonb_typeof(e.value) = 'number'), '{}'::jsonb), now())
      on conflict (driver_id, period) do update set period_from = excluded.period_from, driver_name = coalesce(excluded.driver_name, uber_perf.driver_name),
        plate = coalesce(excluded.plate, uber_perf.plate), vehicle_key = coalesce(excluded.vehicle_key, uber_perf.vehicle_key),
        agency_id = coalesce(excluded.agency_id, uber_perf.agency_id), data = excluded.data, updated_at = now();
    n := n + 1;
  end loop;
  if random() < 0.02 then delete from uber_perf where updated_at < now() - interval '62 days'; end if;
  return n;
end $$;
revoke all on function public.uber_perf_push(text, timestamptz, jsonb) from public, anon;
grant execute on function public.uber_perf_push(text, timestamptz, jsonb) to authenticated;
