-- Revenus Uber par contrat Ludy (21/11/2026, demande d'Ahmed : « combien a rapporté le chauffeur selon son shift de travail, pas selon
-- Uber » ; journée d'Uber 04:00 → 04:00 UTC, shifts de l'agence 7 h → 19/20 h et 19/20/21 h → matin).
-- uber_perf : période « ctr:<n° de contrat> » = chiffres d'Uber du compte qui a roulé sur le véhicule du contrat, du début du contrat
-- à sa fin (ou maintenant) ; « ctrj1:<n° de contrat> » = même chose pour un contrat d'hier, arrêté à la même heure qu'aujourd'hui
-- moins 24 h (comparaison J-1 au même moment). Véhicule et agence = ceux du contrat ; un seul compte Uber par contrat.
-- data : clés numériques e, cash, h, t, a, c, hot, hto, hav, first, last, f (début de la période, ms), to (fin, ms).

create or replace function public.uber_perf_push(p_period text, p_from timestamptz, p_items jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_role text := coalesce((select role from profiles where user_id = auth.uid()), ''); it jsonb; k text; d text; v_key text; v_ag bigint; v_plate text; n integer := 0;
  v_ckey text; v_cag bigint; v_cplate text;
begin
  if auth.uid() is null or v_role not in ('admin', 'manager', 'viewer') then raise exception 'Envoi refusé'; end if;
  if coalesce(p_period, '') !~ '^(shift|cmp):\d{4}-\d{2}-\d{2}:(Jour|Nuit)$' and coalesce(p_period, '') !~ '^(ctr|ctrj1):[A-Za-z0-9_.-]{1,40}$' then raise exception 'Période invalide'; end if;
  -- contrat : véhicule et agence du contrat Ludy (droits de lecture par agence), début du contrat
  if p_period ~ '^(ctr|ctrj1):' then
    select c.vehicle_key, v.agency_id, c.plate into v_ckey, v_cag, v_cplate from contracts c left join vehicles v on v.key = c.vehicle_key where c.num = split_part(p_period, ':', 2);
    if v_ckey is null then raise exception 'Contrat inconnu'; end if;
  end if;
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
    if v_ckey is not null then v_key := v_ckey; v_ag := v_cag; v_plate := coalesce(v_cplate, v_plate); end if;
    -- un contrat = un seul compte Uber : la ligne d'un autre compte pour ce contrat est remplacée
    if v_ckey is not null then delete from uber_perf where period = p_period and driver_id <> d; end if;
    insert into uber_perf (driver_id, period, period_from, driver_name, plate, vehicle_key, agency_id, data, updated_at)
      values (d, p_period, p_from, nullif(left(it->>'n', 80), ''), v_plate, v_key, v_ag,
        coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(it) e
          where e.key in ('e', 'cash', 'h', 't', 'a', 'c', 'hot', 'hto', 'hav', 'first', 'last', 'to', 'f') and jsonb_typeof(e.value) = 'number'), '{}'::jsonb), now())
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
