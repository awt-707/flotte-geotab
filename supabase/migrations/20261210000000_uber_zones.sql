-- Zones de travail Uber (20/11/2026, demande d'Ahmed : « analyser toutes les courses, endroit, jour, heure, pour prédire les zones de
-- prise en charge », « un nuage de zones de travail pour rentabiliser »).
-- Historique des états Uber (uber_live_log) complété par la position GPS donnée par Uber Fleet avec chaque état (carte en temps réel,
-- relevée toutes les 5 à 10 s par l'application Ludy) : position au début de la période (lat0, lng0) et dernière position (lat1, lng1),
-- chauffeur Uber (driver_id). Rien n'est estimé : prise en charge = première position en « Course en cours » ; dépose = dernière
-- position en « Course en cours » ; attente = durée « Disponible » terminée par une demande (vers le client ou en course) ;
-- approche = trajet « En route vers le lieu de prise en charge » (km à vol d'oiseau entre ses deux positions, durée).
-- Historique gardé 180 jours (62 avant). Garde-fou contre les fausses déconnexions en masse (voir uber_live_push).
-- uber_zones(from, to, agence, taille de case) : comptes et sommes par case (taille en degrés, 0,005° ≈ 500 m), jour de la semaine
-- (1 = lundi) et heure, à l'heure réelle du Maroc (table tzRules publiée par le collecteur) ; droits de lecture de uber_live_log.

alter table public.uber_live_log add column if not exists driver_id text;
alter table public.uber_live_log add column if not exists lat0 double precision;
alter table public.uber_live_log add column if not exists lng0 double precision;
alter table public.uber_live_log add column if not exists lat1 double precision;
alter table public.uber_live_log add column if not exists lng1 double precision;

create or replace function public.uber_live_push(p_rows jsonb, p_device text default '', p_url text default '', p_diag text default '', p_full boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare v_role text := coalesce((select role from profiles where user_id = auth.uid()), ''); r jsonb; k text; v_key text; v_ag bigint; n integer := 0;
  o uber_live; g record; v_full boolean := coalesce(p_full, false); v_lat double precision; v_lng double precision; v_did text;
begin
  if auth.uid() is null or v_role not in ('admin', 'manager', 'viewer') then raise exception 'Envoi refusé'; end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 500 then raise exception 'Relevé invalide'; end if;
  -- garde-fou (20/11/2026, fausses déconnexions en masse : liste filtrée par la page d'Uber Fleet prise pour la liste entière) : une
  -- « liste complète » qui contient moins de la moitié des chauffeurs lus en ligne dans les 3 dernières minutes (4 au moins) est traitée
  -- comme partielle ; une vraie vague de déconnexions est enregistrée 3 min plus tard, à l'heure de la dernière lecture de chacun.
  if v_full and jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) * 2 < (select count(*) from uber_live u where u.complete and u.status <> 'offline' and u.observed_at > now() - interval '3 minutes')
     and (select count(*) from uber_live u where u.complete and u.status <> 'offline' and u.observed_at > now() - interval '3 minutes') >= 4 then
    v_full := false;
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    k := norm_plate(r->>'plate');
    if length(k) < 4 or coalesce(r->>'status', '') not in ('available', 'to_pickup', 'on_trip', 'offline', 'unknown') then continue; end if;
    select v.key, v.agency_id into v_key, v_ag from vehicles v where norm_plate(v.plate) = k or norm_plate(v.key) = k limit 1;
    -- position GPS donnée par Uber Fleet avec l'état (carte en temps réel) ; chauffeur Uber (identifiant)
    v_lat := case when jsonb_typeof(r->'lat') = 'number' and (r->>'lat')::double precision between -90 and 90 and (r->>'lat')::double precision <> 0 then (r->>'lat')::double precision end;
    v_lng := case when v_lat is not null and jsonb_typeof(r->'lng') = 'number' and (r->>'lng')::double precision between -180 and 180 and (r->>'lng')::double precision <> 0 then (r->>'lng')::double precision end;
    if v_lng is null then v_lat := null; end if;
    v_did := case when lower(coalesce(r->>'driver', '')) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then lower(r->>'driver') end;
    -- historique : nouvel état (ou plaque revue après plus de 5 min) = période fermée, nouvelle période ouverte ;
    -- « gone » (pas affiché pendant l'absence) seulement si la plaque était lue dans une liste complète
    select * into o from uber_live where plate_key = k;
    if o.plate_key is null or o.status <> r->>'status' or o.observed_at < now() - interval '5 minutes' then
      update uber_live_log set ended_at = case when o.observed_at < now() - interval '5 minutes' then o.observed_at else now() end where plate_key = k and ended_at is null;
      if o.plate_key is not null and o.complete and v_full and o.observed_at < now() - interval '5 minutes' then
        insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at, ended_at)
          values (k, o.plate, v_key, v_ag, o.driver_name, 'gone', o.observed_at, now());
      end if;
      insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at, driver_id, lat0, lng0, lat1, lng1)
        values (k, left(r->>'plate', 30), v_key, v_ag, coalesce(nullif(left(r->>'name', 80), ''), o.driver_name), r->>'status', now(), v_did, v_lat, v_lng, v_lat, v_lng);
    elsif v_lat is not null then
      -- période en cours : dernière position (fin de la période) ; première position si elle manquait
      update uber_live_log set lat1 = v_lat, lng1 = v_lng, lat0 = coalesce(lat0, v_lat), lng0 = coalesce(lng0, v_lng), driver_id = coalesce(driver_id, v_did)
       where plate_key = k and ended_at is null;
    end if;
    insert into uber_live (plate_key, plate, vehicle_key, agency_id, driver_name, status, raw, observed_at, status_since, reader, complete, photo_url, perf)
      values (k, left(r->>'plate', 30), v_key, v_ag, nullif(left(r->>'name', 80), ''), r->>'status', left(r->>'raw', 60), now(), now(), auth.uid(), v_full,
        case when coalesce(r->>'photo', '') ~ '^https://[a-z0-9-]+\.cloudfront\.net/' then left(r->>'photo', 1500) end,
        case when jsonb_typeof(r->'perf') = 'object' then (select jsonb_object_agg(e.key, e.value) from jsonb_each(r->'perf') e
          where e.key in ('e', 'cash', 'h', 't', 'a', 'c', 'first', 'last', 'at') and jsonb_typeof(e.value) = 'number') end)
      on conflict (plate_key) do update set plate = excluded.plate, vehicle_key = excluded.vehicle_key, agency_id = excluded.agency_id,
        driver_name = coalesce(excluded.driver_name, uber_live.driver_name), status = excluded.status, raw = excluded.raw, observed_at = excluded.observed_at, reader = excluded.reader,
        complete = excluded.complete, photo_url = coalesce(excluded.photo_url, uber_live.photo_url), perf = coalesce(excluded.perf, uber_live.perf),
        status_since = case when uber_live.status = excluded.status and uber_live.observed_at > now() - interval '5 minutes' then uber_live.status_since else now() end;
    n := n + 1;
  end loop;
  -- liste complète : plaques lues dans une liste complète et plus affichées depuis 2 min = période fermée, « gone » ouverte (déconnecté)
  if v_full then
    for g in select * from uber_live u where u.complete and u.status <> 'offline' and u.observed_at < now() - interval '2 minutes' and u.observed_at > now() - interval '1 day'
        and exists (select 1 from uber_live_log l where l.plate_key = u.plate_key and l.ended_at is null and l.status <> 'gone') loop
      update uber_live_log set ended_at = g.observed_at where plate_key = g.plate_key and ended_at is null;
      insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at)
        values (g.plate_key, g.plate, g.vehicle_key, g.agency_id, g.driver_name, 'gone', g.observed_at);
    end loop;
  end if;
  insert into uber_live_readers (user_id, device, at, rows, url, diag, complete) values (auth.uid(), left(coalesce(p_device, ''), 80), now(), n, left(p_url, 200), left(p_diag, 20000), v_full)
    on conflict (user_id, device) do update set at = now(), rows = excluded.rows, url = excluded.url, diag = excluded.diag, complete = excluded.complete;
  delete from uber_live where observed_at < now() - interval '3 days';
  if random() < 0.01 then delete from uber_live_log where started_at < now() - interval '180 days'; end if;
  return n;
end $$;
revoke all on function public.uber_live_push(jsonb, text, text, text, boolean) from public, anon;
grant execute on function public.uber_live_push(jsonb, text, text, text, boolean) to authenticated;

-- heure du Maroc : décalage (minutes) d'après la table tzRules ([[instant ms, décalage], …]) ; sans table : +60
create or replace function public.ma_offset_min(p_at timestamptz, p_rules jsonb)
returns integer language sql immutable as $$
  select coalesce((select (e->>1)::int from jsonb_array_elements(case when jsonb_typeof(p_rules) = 'array' then p_rules else '[]'::jsonb end) e
     where jsonb_typeof(e) = 'array' and (e->>0)::bigint <= (extract(epoch from p_at) * 1000)::bigint order by (e->>0)::bigint desc limit 1), 60)
$$;

create or replace function public.uber_zones(p_from timestamptz, p_to timestamptz, p_agency bigint default null, p_cell numeric default 0.005)
returns table (kind text, cy integer, cx integer, dow integer, hour integer, n integer, v double precision)
language sql stable security invoker set search_path = public as $$
  with rules as (select coalesce((select value::jsonb from params where key = 'tzRules' and value ~ '^\s*\['), '[]'::jsonb) r),
  cell as (select greatest(least(coalesce(p_cell, 0.005), 0.05), 0.001)::double precision c),
  l as (
    select u.*, lead(u.status) over w as nst, lead(u.started_at) over w as nat, lag(u.status) over w as pst
      from uber_live_log u
     where u.started_at >= p_from - interval '6 hours' and u.started_at < p_to and (p_agency is null or u.agency_id = p_agency)
    window w as (partition by u.plate_key order by u.started_at)
  ),
  ev as (
    -- prise en charge : début d'une période « Course en cours » (après un autre état), valeur = durée de la course en minutes
    select 'pickup'::text k, l.lat0 la, l.lng0 lo, l.started_at t,
           case when l.ended_at is not null and l.nst is distinct from 'gone' then extract(epoch from l.ended_at - l.started_at) / 60 end val
      from l where l.status = 'on_trip' and l.pst is distinct from 'on_trip' and l.lat0 is not null
    union all
    -- dépose : fin d'une période « Course en cours » suivie d'un autre état lu (pas une perte de lecture)
    select 'dropoff', l.lat1, l.lng1, l.ended_at, null from l where l.status = 'on_trip' and l.ended_at is not null and l.nst in ('available', 'to_pickup', 'offline') and l.lat1 is not null
    union all
    -- attente : « Disponible » terminé par une demande dans les 2 min, valeur = minutes d'attente (lieu = début de l'attente)
    select 'wait', l.lat0, l.lng0, l.started_at, extract(epoch from l.ended_at - l.started_at) / 60
      from l where l.status = 'available' and l.ended_at is not null and l.nst in ('to_pickup', 'on_trip') and l.nat - l.ended_at < interval '2 minutes' and l.lat0 is not null
    union all
    -- disponible sans demande : « Disponible » terminé par une déconnexion (valeur = minutes)
    select 'idle', l.lat0, l.lng0, l.started_at, extract(epoch from l.ended_at - l.started_at) / 60
      from l where l.status = 'available' and l.ended_at is not null and l.nst in ('offline', 'gone') and l.lat0 is not null
    union all
    -- approche : « En route vers le client » suivi de « Course en cours », valeur = km à vol d'oiseau (lieu = où la demande est reçue)
    select 'approach', l.lat0, l.lng0, l.started_at,
           2 * 6371 * asin(sqrt(power(sin(radians(l.lat1 - l.lat0) / 2), 2) + cos(radians(l.lat0)) * cos(radians(l.lat1)) * power(sin(radians(l.lng1 - l.lng0) / 2), 2)))
      from l where l.status = 'to_pickup' and l.nst = 'on_trip' and l.lat0 is not null and l.lat1 is not null
  ),
  loc as (select ev.*, ev.t + make_interval(mins => ma_offset_min(ev.t, (select r from rules))) lt from ev where ev.t >= p_from and ev.t < p_to)
  select loc.k, floor(loc.la / (select c from cell))::int, floor(loc.lo / (select c from cell))::int, extract(isodow from loc.lt)::int, extract(hour from loc.lt)::int,
         count(*)::int, sum(loc.val)::double precision
    from loc group by 1, 2, 3, 4, 5
$$;
revoke all on function public.uber_zones(timestamptz, timestamptz, bigint, numeric) from public, anon;
grant execute on function public.uber_zones(timestamptz, timestamptz, bigint, numeric) to authenticated;
revoke all on function public.ma_offset_min(timestamptz, jsonb) from public, anon;
grant execute on function public.ma_offset_min(timestamptz, jsonb) to authenticated, service_role;

-- Demandes Uber par jour de la semaine et par heure (heure réelle du Maroc), d'après les courses du rapport « Activité des courses »
-- (uber_trips : import manuel ou demandé par Ludy) ; droits de lecture de uber_trips
create or replace function public.uber_demand(p_from timestamptz, p_to timestamptz, p_agency bigint default null)
returns table (dow integer, hour integer, done integer, rider_cancel integer, driver_cancel integer, other integer, km double precision)
language sql stable security invoker set search_path = public as $$
  with rules as (select coalesce((select value::jsonb from params where key = 'tzRules' and value ~ '^\s*\['), '[]'::jsonb) r),
  t as (select u.status, u.km, u.requested_at + make_interval(mins => ma_offset_min(u.requested_at, (select r from rules))) lt
          from uber_trips u where u.requested_at >= p_from and u.requested_at < p_to and (p_agency is null or u.agency_id = p_agency))
  select extract(isodow from lt)::int, extract(hour from lt)::int,
         count(*) filter (where lower(status) = 'completed')::int, count(*) filter (where lower(status) = 'rider_cancelled')::int,
         count(*) filter (where lower(status) = 'driver_cancelled')::int, count(*) filter (where lower(status) not in ('completed', 'rider_cancelled', 'driver_cancelled'))::int,
         sum(km) filter (where lower(status) = 'completed')::double precision
    from t group by 1, 2
$$;
revoke all on function public.uber_demand(timestamptz, timestamptz, bigint) from public, anon;
grant execute on function public.uber_demand(timestamptz, timestamptz, bigint) to authenticated;
