-- Lecture complète d'Uber Fleet (19/11/2026, application Ludy 1.9 ; demande d'Ahmed : plus aucune donnée de l'application de Raphael).
-- Constat sur l'ordinateur d'Ahmed (1.8) : la liste de la « Carte en temps réel » n'écrit que le nom et le téléphone ; l'état n'est lu
-- que pour le chauffeur ouvert. Une plaque qui disparaît de l'écran n'est donc pas un chauffeur déconnecté.
-- * uber_live.complete / uber_live_readers.complete : relevé tiré de la liste complète des chauffeurs (données de la carte, 1.9).
-- * uber_live_push(…, p_full) : lecture partielle = états notés, jamais de période « gone » (déconnecté) ; lecture complète = comme avant.
-- * extrait de diagnostic jusqu'à 20 000 caractères (structure des données d'Uber Fleet, pour régler la lecture).

alter table public.uber_live add column if not exists complete boolean not null default false;
alter table public.uber_live_readers add column if not exists complete boolean not null default false;

drop function if exists public.uber_live_push(jsonb, text, text, text);
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
    insert into uber_live (plate_key, plate, vehicle_key, agency_id, driver_name, status, raw, observed_at, status_since, reader, complete)
      values (k, left(r->>'plate', 30), v_key, v_ag, nullif(left(r->>'name', 80), ''), r->>'status', left(r->>'raw', 60), now(), now(), auth.uid(), v_full)
      on conflict (plate_key) do update set plate = excluded.plate, vehicle_key = excluded.vehicle_key, agency_id = excluded.agency_id,
        driver_name = coalesce(excluded.driver_name, uber_live.driver_name), status = excluded.status, raw = excluded.raw, observed_at = excluded.observed_at, reader = excluded.reader,
        complete = excluded.complete,
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
