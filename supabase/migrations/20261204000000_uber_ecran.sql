-- Lecture d'Uber Fleet par l'application Ludy (18/11/2026, demande d'Ahmed : ne plus dépendre de l'application de bureau de Raphael ;
-- n'importe quel ordinateur où l'application Ludy (1.8) a le volet Uber Fleet ouvert et connecté envoie les états des chauffeurs).
-- * uber_live : dernier état lu sur l'écran Uber Fleet pour chaque plaque (disponible, en route vers le client, en course, hors ligne),
--   heure de lecture = heure de la base ; véhicule de Ludy retrouvé par la plaque (chiffres puis lettres, comme normPlate du site).
-- * uber_live_readers : dernier envoi de chaque ordinateur (compte, appareil, lignes lues, extrait du texte quand rien n'est lu).
-- * uber_live_push(rows, device, url, diag) : envoi du site Ludy (compte connecté : administrateur, gestionnaire, lecture seule).

-- plaque comparée par norm_plate (migration 20261016000000_agences.sql : chiffres puis lettres)

create table if not exists public.uber_live (
  plate_key text primary key,
  plate text not null,
  vehicle_key text,
  agency_id bigint,
  driver_name text,
  status text not null check (status in ('available', 'to_pickup', 'on_trip', 'offline', 'unknown')),
  raw text,
  observed_at timestamptz not null default now(),
  status_since timestamptz not null default now(),   -- depuis quand cet état est lu (hors ligne depuis…)
  reader uuid
);
create index if not exists uber_live_obs on public.uber_live (observed_at);
create index if not exists uber_live_veh on public.uber_live (vehicle_key);

create table if not exists public.uber_live_readers (
  user_id uuid not null,
  device text not null,
  at timestamptz not null default now(),
  rows integer not null default 0,
  url text,
  diag text,
  primary key (user_id, device)
);

-- historique des états lus (journal du shift : connexions, déconnexions, temps par état) ; une ligne par période d'état,
-- « gone » = plus affiché à l'écran (déconnecté, depuis la dernière lecture où il était visible) ; gardé 62 jours
create table if not exists public.uber_live_log (
  id bigserial primary key,
  plate_key text not null,
  plate text,
  vehicle_key text,
  agency_id bigint,
  driver_name text,
  status text not null check (status in ('available', 'to_pickup', 'on_trip', 'offline', 'unknown', 'gone')),
  started_at timestamptz not null,
  ended_at timestamptz
);
create index if not exists uber_live_log_open on public.uber_live_log (plate_key) where ended_at is null;
create index if not exists uber_live_log_time on public.uber_live_log (started_at);
create index if not exists uber_live_log_veh on public.uber_live_log (vehicle_key, started_at);

alter table public.uber_live enable row level security;
alter table public.uber_live_log enable row level security;
revoke all on public.uber_live_log from anon, authenticated;
grant select on public.uber_live_log to authenticated;
grant all on public.uber_live_log to service_role;
drop policy if exists ull_read on public.uber_live_log;
create policy ull_read on public.uber_live_log for select to authenticated
  using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]));
alter table public.uber_live_readers enable row level security;
revoke all on public.uber_live, public.uber_live_readers from anon, authenticated;
grant select on public.uber_live, public.uber_live_readers to authenticated;
grant all on public.uber_live, public.uber_live_readers to service_role;
drop policy if exists ul_read on public.uber_live;
create policy ul_read on public.uber_live for select to authenticated
  using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]));
drop policy if exists ulr_read on public.uber_live_readers;
create policy ulr_read on public.uber_live_readers for select to authenticated
  using ((select public.is_admin()) or user_id = auth.uid());

create or replace function public.uber_live_push(p_rows jsonb, p_device text default '', p_url text default '', p_diag text default '')
returns integer language plpgsql security definer set search_path = public as $$
declare v_role text := coalesce((select role from profiles where user_id = auth.uid()), ''); r jsonb; k text; v_key text; v_ag bigint; n integer := 0;
  o uber_live; g record;
begin
  if auth.uid() is null or v_role not in ('admin', 'manager', 'viewer') then raise exception 'Envoi refusé'; end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 500 then raise exception 'Relevé invalide'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    k := norm_plate(r->>'plate');
    if length(k) < 4 or coalesce(r->>'status', '') not in ('available', 'to_pickup', 'on_trip', 'offline', 'unknown') then continue; end if;
    select v.key, v.agency_id into v_key, v_ag from vehicles v where norm_plate(v.plate) = k or norm_plate(v.key) = k limit 1;
    -- historique : nouvel état (ou plaque revue après plus de 5 min d'absence) = période fermée, nouvelle période ouverte
    select * into o from uber_live where plate_key = k;
    if o.plate_key is null or o.status <> r->>'status' or o.observed_at < now() - interval '5 minutes' then
      update uber_live_log set ended_at = case when o.observed_at < now() - interval '5 minutes' then o.observed_at else now() end where plate_key = k and ended_at is null;
      if o.plate_key is not null and o.observed_at < now() - interval '5 minutes' then
        insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at, ended_at)
          values (k, o.plate, v_key, v_ag, o.driver_name, 'gone', o.observed_at, now());
      end if;
      insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at)
        values (k, left(r->>'plate', 30), v_key, v_ag, coalesce(nullif(left(r->>'name', 80), ''), o.driver_name), r->>'status', now());
    end if;
    insert into uber_live (plate_key, plate, vehicle_key, agency_id, driver_name, status, raw, observed_at, status_since, reader)
      values (k, left(r->>'plate', 30), v_key, v_ag, nullif(left(r->>'name', 80), ''), r->>'status', left(r->>'raw', 60), now(), now(), auth.uid())
      on conflict (plate_key) do update set plate = excluded.plate, vehicle_key = excluded.vehicle_key, agency_id = excluded.agency_id,
        driver_name = coalesce(excluded.driver_name, uber_live.driver_name), status = excluded.status, raw = excluded.raw, observed_at = excluded.observed_at, reader = excluded.reader,
        status_since = case when uber_live.status = excluded.status and uber_live.observed_at > now() - interval '5 minutes' then uber_live.status_since else now() end;
    n := n + 1;
  end loop;
  -- plaques plus affichées depuis 2 min (lecture à jour) : période fermée à la dernière lecture, « gone » ouverte (déconnecté)
  for g in select * from uber_live u where u.status <> 'offline' and u.observed_at < now() - interval '2 minutes' and u.observed_at > now() - interval '1 day'
      and exists (select 1 from uber_live_log l where l.plate_key = u.plate_key and l.ended_at is null and l.status <> 'gone') loop
    update uber_live_log set ended_at = g.observed_at where plate_key = g.plate_key and ended_at is null;
    insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at)
      values (g.plate_key, g.plate, g.vehicle_key, g.agency_id, g.driver_name, 'gone', g.observed_at);
  end loop;
  insert into uber_live_readers (user_id, device, at, rows, url, diag) values (auth.uid(), left(coalesce(p_device, ''), 80), now(), n, left(p_url, 200), left(p_diag, 3000))
    on conflict (user_id, device) do update set at = now(), rows = excluded.rows, url = excluded.url, diag = excluded.diag;
  delete from uber_live where observed_at < now() - interval '3 days';
  if random() < 0.01 then delete from uber_live_log where started_at < now() - interval '62 days'; end if;
  return n;
end $$;
revoke all on function public.uber_live_push(jsonb, text, text, text) from public, anon;
grant execute on function public.uber_live_push(jsonb, text, text, text) to authenticated;
