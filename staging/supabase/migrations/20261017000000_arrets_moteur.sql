-- =============================================================================
-- Arrêts moteur tournant (véhicule immobile, moteur allumé) de 3 min et plus, un par ligne.
-- Calculés par le collecteur à côté du moteur v6 (qui reste inchangé) :
--   litres = compteur Geotab « carburant au ralenti » relevé avant et après l'arrêt, sinon vide (non mesuré) ;
--   ceinture conducteur = minutes bouclée / débouclée pendant l'arrêt quand le véhicule la transmet, sinon vide.
-- À exécuter une fois dans Supabase > SQL Editor (après 20261016000000_agences.sql).
-- =============================================================================
create table if not exists public.engine_stops (
  id text primary key, vehicle_key text not null, plate text, trip_id text, day date, start_at timestamptz, end_at timestamptz,
  dur_min double precision, liters double precision, liters_source text, extra_idle_min double precision, lph double precision,
  belt_on_min double precision, belt_off_min double precision, lat double precision, lon double precision,
  driver_code text, driver_name text, contract_num text, vday date not null, final boolean not null default false
);
create index if not exists engine_stops_vday on public.engine_stops(vehicle_key, vday);
create index if not exists engine_stops_day on public.engine_stops(day);
create index if not exists engine_stops_driver on public.engine_stops(driver_code, day);

alter table public.engine_stops enable row level security;
revoke insert, update, delete on public.engine_stops from anon, authenticated;
revoke select on public.engine_stops from anon;
grant select on public.engine_stops to authenticated;
grant all on public.engine_stops to service_role;
drop policy if exists read_agency on public.engine_stops;
create policy read_agency on public.engine_stops for select to authenticated
  using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]));

-- Écriture des lignes calculées : la table s'ajoute à la liste autorisée (le reste de la fonction est inchangé)
create or replace function public.put_rows(p_table text, p_keys text[], p_rows jsonb, p_final boolean)
returns integer language plpgsql set search_path = public as $$
declare n integer := 0; st jsonb := '{}';
begin
  if p_table not in ('trips', 'idles', 'events', 'fuel', 'levels', 'engine_stops') then raise exception 'table %', p_table; end if;
  p_rows := coalesce(p_rows, '[]'::jsonb); p_keys := coalesce(p_keys, '{}');
  if p_table = 'fuel' then
    select coalesce(jsonb_object_agg(id, status), '{}') into st from fuel
     where coalesce(status, '') <> '' and ((vehicle_key || '|' || vday::text) = any(p_keys)
       or id in (select x->>'id' from jsonb_array_elements(p_rows) x));
  end if;
  if p_final then
    execute format('delete from %I where (vehicle_key || ''|'' || vday::text) = any($1) or id in (select x->>''id'' from jsonb_array_elements($2) x)', p_table)
      using p_keys, p_rows;
    execute format('insert into %I select distinct on (id) * from jsonb_populate_recordset(null::%I, $1) on conflict (id) do nothing', p_table, p_table)
      using p_rows;
  else
    execute format('delete from %I where final = false and id in (select x->>''id'' from jsonb_array_elements($1) x)', p_table) using p_rows;
    execute format('insert into %I select distinct on (r.id) r.* from jsonb_populate_recordset(null::%I, $1) r
      where not exists (select 1 from vehicle_days d where d.id = r.vehicle_key || ''|'' || r.vday::text) on conflict (id) do nothing', p_table, p_table)
      using p_rows;
  end if;
  get diagnostics n = row_count;
  if p_table = 'fuel' and st <> '{}' then update fuel set status = st->>id where st ? id; end if;
  return n;
end $$;

-- Finalisation avec les arrêts moteur tournant (8 paramètres ; l'ancienne version à 7 reste pour un collecteur pas encore mis à jour)
create or replace function public.finalize_vdays(p_keys text[], p_trips jsonb, p_idles jsonb, p_events jsonb, p_fuel jsonb, p_levels jsonb, p_sync jsonb, p_stops jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare r jsonb;
begin
  r := public.finalize_vdays(p_keys, p_trips, p_idles, p_events, p_fuel, p_levels, p_sync);
  return r || jsonb_build_object('engine_stops', put_rows('engine_stops', p_keys, p_stops, true));
end $$;

-- Changement de plaque : les arrêts suivent le véhicule
create or replace function public.rekey_vehicle(p_alias text, p_canon text)
returns date language plpgsql set search_path = public as $$
declare t text; d date; m date; pre text := p_alias || '|'; np integer := length(p_alias) + 2;
begin
  if p_alias = p_canon or coalesce(p_alias, '') = '' or coalesce(p_canon, '') = '' then return null; end if;
  foreach t in array array['trips', 'idles', 'events', 'fuel', 'levels', 'engine_stops'] loop
    execute format('select min(vday) from %I where vehicle_key = $1', t) into d using p_alias;
    if d is not null and (m is null or d < m) then m := d; end if;
    -- identifiant déjà présent sous la clé historique : doublon
    execute format('delete from %I a where a.vehicle_key = $1 and left(a.id, length($3)) = $3 and exists (select 1 from %I b where b.id = $2 || ''|'' || substr(a.id, $4))', t, t)
      using p_alias, p_canon, pre, np;
    execute format('update %I set vehicle_key = $2, id = case when left(id, length($3)) = $3 then $2 || ''|'' || substr(id, $4) else id end where vehicle_key = $1', t)
      using p_alias, p_canon, pre, np;
  end loop;
  update idles set trip_id = p_canon || '|' || substr(trip_id, np) where left(trip_id, length(pre)) = pre;
  update engine_stops set trip_id = p_canon || '|' || substr(trip_id, np) where left(trip_id, length(pre)) = pre;
  delete from vehicle_days a where a.vehicle_key = p_alias and exists (select 1 from vehicle_days b where b.id = p_canon || '|' || substr(a.id, np));
  update vehicle_days set vehicle_key = p_canon, id = p_canon || '|' || substr(id, np) where vehicle_key = p_alias;
  update contracts set vehicle_key = p_canon where vehicle_key = p_alias;
  update journal set vehicle_key = p_canon where vehicle_key = p_alias;
  update alerts set vehicle_key = p_canon where vehicle_key = p_alias;
  delete from live_status where vehicle_key = p_alias;
  return m;
end $$;

-- Archivage mensuel
create or replace function public.purge_before(p_table text, p_before date)
returns integer language plpgsql set search_path = public as $$
declare n integer;
begin
  if p_table in ('trips', 'idles', 'events', 'fuel', 'levels', 'engine_stops') then execute format('delete from %I where vday < $1', p_table) using p_before;
  elsif p_table in ('vehicle_days', 'journal', 'alerts') then execute format('delete from %I where day < $1', p_table) using p_before;
  elsif p_table = 'logs' then delete from logs where at < p_before;
  elsif p_table = 'jobs' then delete from jobs where done_at is not null and created_at < p_before;
  else raise exception 'table %', p_table; end if;
  get diagnostics n = row_count; return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array['put_rows(text,text[],jsonb,boolean)', 'finalize_vdays(text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)',
    'rekey_vehicle(text,text)', 'purge_before(text,date)'] loop
    execute 'revoke execute on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- Durée mini d'un arrêt moteur tournant (réglable dans Réglages)
insert into public.params (key, label, value, note, sort)
values ('engStopMin', 'Arrêt moteur tournant : durée mini (min)', '3', 'Véhicule immobile moteur allumé : chaque arrêt d''au moins cette durée est listé avec ses litres réels (page Arrêts moteur)', 16)
on conflict (key) do nothing;
