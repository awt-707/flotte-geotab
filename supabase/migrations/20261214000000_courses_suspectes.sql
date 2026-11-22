-- =============================================================================
-- Courses Uber suspectes (22/11/2026, demande d'Ahmed, « très important ») : chauffeur « En route vers le lieu de prise en charge »
-- (vert) qui passe ensuite « Disponible » (gris) ou hors ligne / disparu de l'écran, sans « Course en cours » : il a pu demander au client
-- d'annuler puis le prendre en cachette. Chaque cas est enregistré (uber_suspects) dès que la période Uber se ferme (déclencheur sur
-- uber_live_log, différé à la fin de la transaction : les disparitions en masse d'une lecture interrompue sont reconnues et ignorées),
-- le site alerte en temps réel, le collecteur mesure ensuite les km Geotab parcourus dans les suspectWinMin minutes qui suivent, hors
-- course Uber (km_free), et pose un verdict ; le gestionnaire classe (À vérifier / Justifié / Confirmé) avec un commentaire.
-- Droits : lecture comme uber_live_log (administrateur ; gestionnaire / lecture seule = véhicules de ses agences) ; statut et commentaire
-- par l'administrateur et les gestionnaires ; mesures écrites par le collecteur seul (clé service).
-- À exécuter dans Supabase > SQL Editor après 20261213000000_tchat.sql. Rejouable.
-- =============================================================================
create table if not exists public.uber_suspects (
  id bigint generated always as identity primary key,
  log_id bigint unique,                      -- période « en route » de uber_live_log (sans clé étrangère : l'historique reste quand le journal est purgé à 180 j)
  plate_key text not null,
  plate text,
  vehicle_key text,
  agency_id bigint,
  driver_id text,
  driver_name text,
  route_from timestamptz not null,           -- début de « En route vers le client »
  route_to timestamptz not null,             -- fin (= changement d'état)
  lat double precision,                      -- dernière position donnée par Uber Fleet pendant « en route »
  lng double precision,
  next_status text not null,                 -- available, offline, gone
  next_at timestamptz not null,
  level text not null default 'Suspect' check (level in ('Suspect', 'Info')),   -- Info = en route trop court (suspectMinS) : listé, sans alerte
  win_until timestamptz not null,            -- fin de la fenêtre de mesure des km
  km_after numeric,                          -- km Geotab parcourus dans la fenêtre
  km_free numeric,                           -- dont km hors course Uber (états on_trip / to_pickup retirés)
  moved_m integer,                           -- éloignement maximal (m) du lieu du changement
  km_done boolean not null default false,
  km_note text,                              -- verdict du collecteur
  verdict text check (verdict in ('roulé', 'sur place', 'non mesuré')),
  status text not null default 'À vérifier' check (status in ('À vérifier', 'Justifié', 'Confirmé')),
  comment text,
  checked_by uuid,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists uber_suspects_at on public.uber_suspects(next_at desc);
create index if not exists uber_suspects_veh on public.uber_suspects(vehicle_key, next_at desc);
create index if not exists uber_suspects_todo on public.uber_suspects(km_done, next_at) where not km_done;

alter table public.uber_suspects enable row level security;
revoke all on public.uber_suspects from anon, authenticated;
grant select on public.uber_suspects to authenticated;
grant all on public.uber_suspects to service_role;
drop policy if exists usp_read on public.uber_suspects;
create policy usp_read on public.uber_suspects for select to authenticated
  using ((select public.is_admin()) or vehicle_key = any((select public.my_vehicle_keys())::text[]) or agency_id = any((select public.my_agency_ids())::bigint[]));

insert into public.params (key, label, value, note, sort) values
  ('suspectMinS', 'Courses suspectes : en route au moins (s)', '60', 'Chauffeur « en route vers le client » pendant moins que ce temps puis disponible / hors ligne : listé en information, sans alerte (annulation immédiate du client).', 140),
  ('suspectWinMin', 'Courses suspectes : km mesurés pendant (min)', '20', 'Minutes après le changement d''état pendant lesquelles le collecteur mesure les km Geotab parcourus hors course Uber.', 141),
  ('suspectKm', 'Courses suspectes : km sans course Uber = roulé', '1.5', 'Au-delà de ces km parcourus hors course Uber dans la fenêtre, verdict « roulé » (course cachée probable).', 142)
on conflict (key) do update set label = excluded.label, note = excluded.note, sort = excluded.sort;

/**
 * Déclencheur (différé à la fin de la transaction) : nouvelle période available / offline / gone juste après une période to_pickup
 * de la même plaque = cas suspect. Disparitions en masse (3 plaques ou plus « gone » à 30 s près : lecture d'Uber Fleet interrompue) ignorées.
 */
create or replace function public.uber_suspect_trg() returns trigger language plpgsql security definer set search_path = public as $$
declare p uber_live_log; v_min integer; v_win integer;
begin
  if new.status not in ('available', 'offline', 'gone') then return null; end if;
  select * into p from uber_live_log l where l.plate_key = new.plate_key and l.status = 'to_pickup' and l.id <> new.id and l.ended_at is not null
    and l.ended_at between new.started_at - interval '3 minutes' and new.started_at + interval '1 second' order by l.ended_at desc, l.id desc limit 1;
  if p.id is null then return null; end if;
  if p.ended_at - p.started_at < interval '10 seconds' then return null; end if;   -- clignotement de l'écran
  if new.status = 'gone' and (select count(distinct plate_key) from uber_live_log g where g.status = 'gone'
      and g.started_at between new.started_at - interval '30 seconds' and new.started_at + interval '30 seconds') >= 3 then return null; end if;
  v_min := coalesce((select value::integer from params where key = 'suspectMinS' and value ~ '^[0-9]+$'), 60);
  v_win := coalesce((select value::integer from params where key = 'suspectWinMin' and value ~ '^[0-9]+$'), 20);
  insert into uber_suspects (log_id, plate_key, plate, vehicle_key, agency_id, driver_id, driver_name, route_from, route_to, lat, lng, next_status, next_at, level, win_until)
    values (p.id, p.plate_key, coalesce(new.plate, p.plate), coalesce(new.vehicle_key, p.vehicle_key), coalesce(new.agency_id, p.agency_id), coalesce(p.driver_id, new.driver_id),
      coalesce(new.driver_name, p.driver_name), p.started_at, p.ended_at, p.lat1, p.lng1, new.status, new.started_at,
      case when p.ended_at - p.started_at >= make_interval(secs => v_min) then 'Suspect' else 'Info' end, new.started_at + make_interval(mins => v_win))
    on conflict (log_id) do nothing;
  return null;
end $$;
drop trigger if exists uber_suspect_trg on public.uber_live_log;
create constraint trigger uber_suspect_trg after insert on public.uber_live_log deferrable initially deferred for each row execute function public.uber_suspect_trg();

/** Classement par le gestionnaire (ses véhicules) ou l'administrateur */
create or replace function public.uber_suspect_set(p_id bigint, p_status text, p_comment text) returns void language plpgsql security definer set search_path = public as $$
declare s uber_suspects;
begin
  if coalesce(public.my_role(), '') not in ('admin', 'manager') then raise exception 'Accès refusé'; end if;
  if p_status not in ('À vérifier', 'Justifié', 'Confirmé') then raise exception 'Statut inconnu'; end if;
  select * into s from uber_suspects where id = p_id;
  if s.id is null then raise exception 'Cas inconnu'; end if;
  if not public.is_admin() and not (s.vehicle_key = any((select public.my_vehicle_keys())::text[]) or s.agency_id = any((select public.my_agency_ids())::bigint[])) then raise exception 'Accès refusé'; end if;
  update uber_suspects set status = p_status, comment = left(p_comment, 500), checked_by = auth.uid(), checked_at = now(), updated_at = now() where id = p_id;
end $$;
revoke execute on function public.uber_suspect_set(bigint, text, text) from public, anon;
grant execute on function public.uber_suspect_set(bigint, text, text) to authenticated;

-- temps réel : alerte à l'instant sur tous les Ludy ouverts (création) et verdict des km (mise à jour)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.uber_suspects'; exception when others then null; end;
  end if;
end $$;
