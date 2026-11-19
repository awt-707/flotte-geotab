-- Exploration d'Uber Fleet et photo des chauffeurs (19/11/2026, demandes d'Ahmed : « inspecte Uber Fleet de A à Z pour comprendre comment
-- il fonctionne et quelles infos on peut extraire » ; « prends la photo du chauffeur et rajoute-la à droite de chaque plaque »).
-- * uber_catalog : ce que la page Uber Fleet ouverte dans l'application Ludy charge d'elle-même (adresse, opération GraphQL, requête,
--   squelette de la réponse) et chaque page visitée (texte affiché, colonnes) ; lu par l'administrateur seulement.
-- * uber_catalog_push(items) : envoi du site Ludy (compte connecté : administrateur, gestionnaire, lecture seule).
-- * uber_live.photo_url : photo du chauffeur affichée par Uber Fleet (adresse signée cloudfront.net, valable quelques heures, relue à
--   chaque lecture).

create table if not exists public.uber_catalog (
  k text primary key,
  url text, op text, method text,
  n integer not null default 0,
  first_at timestamptz, last_at timestamptz,
  size integer, req text, res text,
  by_user uuid,
  updated_at timestamptz not null default now()
);
alter table public.uber_catalog enable row level security;
revoke all on public.uber_catalog from anon, authenticated;
grant select on public.uber_catalog to authenticated;
grant all on public.uber_catalog to service_role;
drop policy if exists uc_read on public.uber_catalog;
create policy uc_read on public.uber_catalog for select to authenticated using ((select public.is_admin()));

create or replace function public.uber_catalog_push(p_items jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_role text := coalesce((select role from profiles where user_id = auth.uid()), ''); it jsonb; n integer := 0;
begin
  if auth.uid() is null or v_role not in ('admin', 'manager', 'viewer') then raise exception 'Envoi refusé'; end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 200 then raise exception 'Envoi invalide'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if coalesce(it->>'k', '') = '' then continue; end if;
    if (select count(*) from uber_catalog) >= 3000 and not exists (select 1 from uber_catalog where k = left(it->>'k', 300)) then continue; end if;
    insert into uber_catalog (k, url, op, method, n, first_at, last_at, size, req, res, by_user, updated_at)
      values (left(it->>'k', 300), left(it->>'url', 300), left(it->>'op', 100), left(it->>'m', 10),
        least(coalesce((it->>'n')::numeric, 0), 1e9)::integer,
        to_timestamp(least(greatest(coalesce((it->>'first')::numeric, 0), 0), 4e12) / 1000), to_timestamp(least(greatest(coalesce((it->>'at')::numeric, 0), 0), 4e12) / 1000),
        least(coalesce((it->>'size')::numeric, 0), 1e9)::integer, left(it->>'req', 4000), left(it->>'res', 6000), auth.uid(), now())
      on conflict (k) do update set n = greatest(uber_catalog.n, excluded.n), last_at = greatest(uber_catalog.last_at, excluded.last_at), size = excluded.size,
        req = coalesce(nullif(excluded.req, ''), uber_catalog.req), res = coalesce(nullif(excluded.res, ''), uber_catalog.res), by_user = excluded.by_user, updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.uber_catalog_push(jsonb) from public, anon;
grant execute on function public.uber_catalog_push(jsonb) to authenticated;

alter table public.uber_live add column if not exists photo_url text;

create or replace function public.uber_live_push(p_rows jsonb, p_device text default '', p_url text default '', p_diag text default '', p_full boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare v_role text := coalesce((select role from profiles where user_id = auth.uid()), ''); r jsonb; k text; v_key text; v_ag bigint; n integer := 0;
  o uber_live; g record; v_full boolean := coalesce(p_full, false);
begin
  if auth.uid() is null or v_role not in ('admin', 'manager', 'viewer') then raise exception 'Envoi refusé'; end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 500 then raise exception 'Relevé invalide'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    k := norm_plate(r->>'plate');
    if length(k) < 4 or coalesce(r->>'status', '') not in ('available', 'to_pickup', 'on_trip', 'offline', 'unknown') then continue; end if;
    select v.key, v.agency_id into v_key, v_ag from vehicles v where norm_plate(v.plate) = k or norm_plate(v.key) = k limit 1;
    -- historique : nouvel état (ou plaque revue après plus de 5 min) = période fermée, nouvelle période ouverte ;
    -- « gone » (pas affiché pendant l'absence) seulement si la plaque était lue dans une liste complète
    select * into o from uber_live where plate_key = k;
    if o.plate_key is null or o.status <> r->>'status' or o.observed_at < now() - interval '5 minutes' then
      update uber_live_log set ended_at = case when o.observed_at < now() - interval '5 minutes' then o.observed_at else now() end where plate_key = k and ended_at is null;
      if o.plate_key is not null and o.complete and v_full and o.observed_at < now() - interval '5 minutes' then
        insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at, ended_at)
          values (k, o.plate, v_key, v_ag, o.driver_name, 'gone', o.observed_at, now());
      end if;
      insert into uber_live_log (plate_key, plate, vehicle_key, agency_id, driver_name, status, started_at)
        values (k, left(r->>'plate', 30), v_key, v_ag, coalesce(nullif(left(r->>'name', 80), ''), o.driver_name), r->>'status', now());
    end if;
    insert into uber_live (plate_key, plate, vehicle_key, agency_id, driver_name, status, raw, observed_at, status_since, reader, complete, photo_url)
      values (k, left(r->>'plate', 30), v_key, v_ag, nullif(left(r->>'name', 80), ''), r->>'status', left(r->>'raw', 60), now(), now(), auth.uid(), v_full,
        case when coalesce(r->>'photo', '') ~ '^https://[a-z0-9-]+\.cloudfront\.net/' then left(r->>'photo', 1500) end)
      on conflict (plate_key) do update set plate = excluded.plate, vehicle_key = excluded.vehicle_key, agency_id = excluded.agency_id,
        driver_name = coalesce(excluded.driver_name, uber_live.driver_name), status = excluded.status, raw = excluded.raw, observed_at = excluded.observed_at, reader = excluded.reader,
        complete = excluded.complete, photo_url = coalesce(excluded.photo_url, uber_live.photo_url),
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
  if random() < 0.01 then delete from uber_live_log where started_at < now() - interval '62 days'; end if;
  return n;
end $$;
revoke all on function public.uber_live_push(jsonb, text, text, text, boolean) from public, anon;
grant execute on function public.uber_live_push(jsonb, text, text, text, boolean) to authenticated;
